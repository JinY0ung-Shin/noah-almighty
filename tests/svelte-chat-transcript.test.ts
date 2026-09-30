// ChatView transcript rendering. Guards the deferred-card behavior that keeps a
// long transcript cheap: <details> only HIDES its children, so leaving the
// "생각 과정" body and the "작업 내역" tree in the template cost a markdown parse
// and an ActivityTree mount for EVERY message on load. Both now render on first
// open. See lib/format.ts renderMarkdownCached for the matching per-token fix.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { attachRun } from "../src/client/src/lib/chat.js";
import { readState, replaceState, updateState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";
import { PPTX_MEDIA_TYPE } from "../src/shared/shareLinks.js";

const THINKING = "먼저 요구사항을 정리한다";
const ANSWER = "정리한 결과입니다";

const avatar = {
  id: "avatar-1",
  username: "ava",
  displayName: "아바타",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "public",
  isOwn: true,
  elevated: true,
  plugins: [],
} as unknown as AvatarDetail;

function assistantMessage(): StoredMessage {
  return {
    id: "m-1",
    conversationId: "conv-1",
    role: "assistant",
    content: ANSWER,
    createdAt: "2026-07-26T01:00:00.000Z",
    response: {
      kind: "text",
      runtime: "claude",
      summary: "완료",
      text: ANSWER,
      thinking: THINKING,
      activity: {
        agents: [{ id: "main", parentId: "", label: "main", status: "done", isMain: true }],
        tools: [{ id: "t-1", agentId: "main", kind: "tool", label: "Read", detail: "notes.md", status: "done" }],
        tasks: [],
      },
    },
  } as unknown as StoredMessage;
}

function pane(messages: StoredMessage[]): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
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
    groupKnowledgeOff: [],
  } as unknown as ChatPane;
}

// `toggle` is queued as a TASK after `open` flips (per spec, and jsdom matches),
// so a click needs one macrotask before the handler has run — a microtask tick is
// not enough. The browser paints only after that task, so there is no real flash.
async function clickSummary(card: HTMLDetailsElement): Promise<void> {
  await fireEvent.click(card.querySelector("summary")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
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
  // ChatView's mount fires background loads; answer them with empty collections
  // so a missing key can't overwrite seeded state with undefined.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
  replaceState({ avatars: [], chatPanes: [pane([assistantMessage()])], activePaneId: "pane-1" });
});

describe("ChatView transcript", () => {
  it("renders an anchored file card inline at its creation point, not below the text", () => {
    const first = "다이어그램을 만들었습니다.";
    const rest = "이어서 구조를 설명합니다.";
    const message = {
      ...assistantMessage(),
      content: `${first}\n\n${rest}`,
      attachments: [
        {
          id: "f-1",
          kind: "file",
          mediaType: "application/vnd.jgraph.mxfile",
          name: "diagram.drawio",
          size: 1234,
          anchor: first.length,
        },
      ],
      response: { kind: "text", runtime: "claude", summary: "완료", text: `${first}\n\n${rest}` },
    } as unknown as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([message])], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const flow = Array.from(
      container.querySelectorAll(".message.assistant .bubble > .md, .message.assistant .bubble > .msg-images"),
    );
    expect(flow).toHaveLength(3);
    expect(flow[0].className).toContain("md");
    expect(flow[0].textContent).toContain(first);
    expect(flow[0].textContent).not.toContain(rest);
    expect(flow[1].className).toContain("msg-images");
    expect(flow[1].textContent).toContain("diagram.drawio");
    expect(flow[2].textContent).toContain(rest);
  });

  it("keeps a live card pinned between text segments and the caret on the tail", () => {
    const first = "첫 문단";
    const live = pane([]);
    (live as unknown as Record<string, unknown>).streaming = true;
    live.liveText = `${first}\n\n다음 문단`;
    live.liveAttachments = [
      {
        id: "f-live",
        kind: "file",
        mediaType: "application/pdf",
        name: "report.pdf",
        anchor: first.length,
      },
    ];
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const bubble = container.querySelector(".message.assistant .bubble")!;
    const flow = Array.from(bubble.querySelectorAll(":scope > .md, :scope > .msg-images"));
    expect(flow).toHaveLength(3);
    expect(flow[0].textContent).toContain(first);
    expect(flow[1].textContent).toContain("report.pdf");
    expect(flow[2].textContent).toContain("다음 문단");
    // The stream caret rides the tail segment (below the card), never the first.
    expect(flow[0].querySelector(".stream-caret")).toBeNull();
    expect(flow[2].querySelector(".stream-caret")).not.toBeNull();
  });

  it("renders the answer body but defers the thinking / activity cards until opened", async () => {
    const { container } = render(ChatView);

    // The answer itself is always rendered — only the collapsed cards are deferred.
    expect(container.querySelector(".message.assistant .md")?.textContent).toContain(ANSWER);
    expect(screen.getByText("생각 과정")).toBeTruthy();
    expect(container.querySelector(".thinking-card-body")).toBeNull();
    expect(container.querySelector(".agent-activity")).toBeNull();

    // Drive it the way a user does — click the <summary>; jsdom flips `open` and
    // fires `toggle`, so this covers the real wiring, not just the handler.
    const thinkingCard = container.querySelector<HTMLDetailsElement>("details.thinking-card")!;
    await clickSummary(thinkingCard);
    expect(thinkingCard.open).toBe(true);
    expect(container.querySelector(".thinking-card-body")?.textContent).toContain(THINKING);

    const activityCard = container.querySelector<HTMLDetailsElement>("details.activity-done")!;
    await clickSummary(activityCard);
    expect(container.querySelector(".agent-activity")).not.toBeNull();

    // Closing releases the body again, so scrolling past reopened cards stays cheap.
    await clickSummary(thinkingCard);
    expect(thinkingCard.open).toBe(false);
    expect(container.querySelector(".thinking-card-body")).toBeNull();
  });

  it("puts the activity card BELOW the answer, in the stored and the live bubble alike", () => {
    // Stored bubble: the card is a footnote about how the answer was made, so it
    // follows the text — and matching the live position means nothing teleports
    // when a stream finalizes into a stored message.
    const { container } = render(ChatView);
    const storedBubble = container.querySelector(".message.assistant .bubble")!;
    const storedText = storedBubble.querySelector(":scope > .md")!;
    const storedCard = storedBubble.querySelector(":scope > details.activity-done")!;
    expect(
      Boolean(storedText.compareDocumentPosition(storedCard) & Node.DOCUMENT_POSITION_FOLLOWING),
      "stored activity card follows the answer text",
    ).toBe(true);
  });

  it("keeps the live activity card at the streaming edge: after the text, before the status line", () => {
    // Live bubble: the card grows as tools run and the text grows as it streams.
    // At the top each kind of growth shoved the other around; at the bottom both
    // just extend the edge autoscroll already follows.
    const live = pane([]);
    (live as unknown as Record<string, unknown>).streaming = true;
    live.liveText = "본문이 먼저 흐른다";
    live.liveAgents = [{ id: "main", parentId: "", label: "main", status: "running", isMain: true }] as never;
    live.liveTools = [
      { id: "t-live", agentId: "main", kind: "tool", label: "Read", detail: "notes.md", status: "running" },
    ] as never;
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const bubble = container.querySelector(".message.assistant .bubble")!;
    const text = bubble.querySelector(":scope > .md")!;
    const card = bubble.querySelector(":scope > details.activity-live")!;
    const status = bubble.querySelector(":scope > .stream-status")!;
    expect(
      Boolean(text.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
      "live activity card follows the streamed text",
    ).toBe(true);
    expect(
      Boolean(card.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING),
      "and stays above the stream status line",
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* background phase: each bubble shows its own live rows               */
/* ------------------------------------------------------------------ */

describe("ChatView transcript · background phase", () => {
  it("renders the finished turn's and each wake-up turn's rows under their own bubbles", () => {
    const turn = { ...assistantMessage(), id: "bg-msg-1", response: { kind: "text", runtime: "claude", text: ANSWER } };
    const wake = { ...assistantMessage(), id: "wake-1", content: "결과 보고", response: { kind: "text", runtime: "claude", text: "결과 보고" } };
    const live = pane([turn, wake] as unknown as StoredMessage[]);
    Object.assign(live, {
      streaming: true,
      backgroundPhase: true,
      backgroundMessageId: "bg-msg-1",
      backgroundTasks: [{ taskId: "a-77", taskType: "local_agent", description: "조사" }],
      segmentMessageIds: ["bg-msg-1", "wake-1"],
      liveSegment: 2,
      liveAgents: [
        { id: "main", parentId: "", label: "", status: "running", isMain: true },
        { id: "ag1", parentId: "main", label: "general-purpose · 조사", status: "running", isMain: false, background: true, segment: 0 },
      ],
      liveTools: [
        { id: "t1", agentId: "main", kind: "tool", label: "명령 실행", detail: "ls", status: "done", segment: 0 },
        { id: "ag1-read", agentId: "ag1", kind: "tool", label: "파일 읽기", detail: "a.md", status: "running", segment: 0 },
        { id: "w1", agentId: "main", kind: "tool", label: "내용 검색", detail: "needle", status: "done", segment: 1 },
      ],
    });
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const bubbles = [...container.querySelectorAll(".message.assistant .bubble")];
    // [finished turn, wake-up turn, trailing live bubble]
    expect(bubbles).toHaveLength(3);
    const turnCard = bubbles[0].querySelector(":scope > details.activity-live")!;
    expect(turnCard.querySelector(".activity-summary-text")?.textContent).toBe("도구 2개 · 에이전트 1개 진행 중");
    expect(turnCard.querySelector(".agent-bg-badge")?.textContent).toBe("백그라운드");
    expect([...turnCard.querySelectorAll(".tool-row .tool-arg")].map((n) => n.textContent)).toEqual(["ls", "a.md"]);
    const wakeCard = bubbles[1].querySelector(":scope > details.activity-live")!;
    expect(wakeCard.querySelector(".activity-summary-text")?.textContent).toBe("도구 1개 사용함");
    expect([...wakeCard.querySelectorAll(".tool-row .tool-arg")].map((n) => n.textContent)).toEqual(["needle"]);
    // Nothing is in flight: the trailing bubble shows the background note, not a copy of the tree.
    expect(bubbles[2].querySelector("details.activity-live")).toBeNull();
    expect(bubbles[2].querySelector(".bg-task-note")?.textContent).toContain("백그라운드 작업 1개 진행 중 · 조사");
  });
});

/* ------------------------------------------------------------------ */
/* mid-turn messages ("steers")                                        */
/* ------------------------------------------------------------------ */

describe("ChatView transcript · mid-turn messages", () => {
  it("shows a steer the server has not delivered yet as a pending bubble", () => {
    const live = pane([]);
    (live as unknown as Record<string, unknown>).streaming = true;
    (live as unknown as Record<string, unknown>).steers = [
      { id: "s-1", text: "이것도 확인해 주세요", createdAt: "2026-09-21T01:00:00.000Z" },
    ];
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const pending = container.querySelector(".message.user.steer-pending")!;
    expect(pending).toBeTruthy();
    expect(pending.querySelector(".steer-badge")?.textContent).toBe("전달 대기 중");
    expect(pending.querySelector(".bubble")?.textContent).toBe("이것도 확인해 주세요");
    // It waits at the streaming edge: after the transcript, above the live answer.
    const liveBubble = container.querySelector(".message.assistant")!;
    expect(
      Boolean(pending.compareDocumentPosition(liveBubble) & Node.DOCUMENT_POSITION_FOLLOWING),
      "the pending steer sits above the live assistant bubble",
    ).toBe(true);
  });

  it("marks a delivered steer in the transcript so it is not read as an ordinary turn", () => {
    const steered = {
      id: "u-steer",
      conversationId: "conv-1",
      role: "user",
      content: "중간에 끼어든 말",
      kind: "steer",
      createdAt: "2026-07-26T01:00:00.000Z",
      response: null,
    } as unknown as StoredMessage;
    const plain = { ...steered, id: "u-plain", content: "평범한 질문", kind: undefined } as unknown as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([plain, steered])], activePaneId: "pane-1" });

    const { container } = render(ChatView);
    const rows = Array.from(container.querySelectorAll(".message.user"));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".steer-badge")).toBeNull();
    expect(rows[1].querySelector(".steer-badge")?.textContent).toBe("응답 중 전달");
  });
});

/* ------------------------------------------------------------------ */
/* 여기서부터 다시: editing an earlier message in place                  */
/* ------------------------------------------------------------------ */

function userRow(id: string, content: string, kind?: "steer" | "queued"): StoredMessage {
  return {
    id,
    conversationId: "conv-1",
    role: "user",
    content,
    ...(kind ? { kind } : {}),
    createdAt: "2026-07-26T01:00:00.000Z",
    response: null,
  } as unknown as StoredMessage;
}

function editButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.msg-actions button[aria-label="편집"]'));
}

describe("ChatView transcript · 여기서부터 다시", () => {
  it("offers 편집 only on rows that opened their own turn — never a steer or a queued row", () => {
    replaceState({
      avatars: [],
      chatPanes: [pane([userRow("u-plain", "평범한 질문"), userRow("u-steer", "중간에 끼어든 말", "steer"), userRow("u-queued", "대기열 메시지", "queued"), assistantMessage()])],
      activePaneId: "pane-1",
    });
    const { container } = render(ChatView);
    const rows = Array.from(container.querySelectorAll(".message.user"));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => Boolean(r.querySelector('button[aria-label="편집"]')))).toEqual([true, false, false]);
    // A queued row still reads as an ordinary bubble: no steer badge.
    expect(rows[2].querySelector(".steer-badge")).toBeNull();
  });

  it("offers no 편집 while the pane is streaming", () => {
    const live = pane([userRow("u-1", "질문"), assistantMessage()]);
    (live as unknown as Record<string, unknown>).streaming = true;
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    expect(editButtons(container)).toHaveLength(0);
  });

  it("turns the bubble into an editor holding the message text, and 취소 turns it back", async () => {
    replaceState({ avatars: [], chatPanes: [pane([userRow("u-1", "원래 질문"), assistantMessage()])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    await fireEvent.click(editButtons(container)[0]);
    await tick();
    const bubble = container.querySelector(".message.user .bubble")!;
    expect(bubble.classList.contains("rewind-editing")).toBe(true);
    const input = bubble.querySelector<HTMLTextAreaElement>("textarea.rewind-editor-input")!;
    expect(input.value).toBe("원래 질문");
    expect(bubble.querySelector(".rewind-editor-hint")?.textContent).toContain("이후 대화는 삭제됩니다");
    // The composer is a different field: its draft is not touched by opening the editor.
    expect(readState().chatPanes[0].draft).toBe("");
    // The action row drops its own 편집 while the editor is open.
    expect(editButtons(container)).toHaveLength(0);

    await fireEvent.input(input, { target: { value: "" } });
    await tick();
    const send = within(bubble as HTMLElement).getByRole("button", { name: "보내기" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(within(bubble as HTMLElement).getByRole("button", { name: "취소" }));
    await tick();
    expect(readState().chatPanes[0].rewindEdit).toBeNull();
    expect(container.querySelector("textarea.rewind-editor-input")).toBeNull();
    expect(container.querySelector(".message.user .bubble")?.textContent).toContain("원래 질문");
  });

  it("asks before rewinding when Enter sends the edit, and Escape leaves the editor", async () => {
    const { confirmation, resolveConfirmation } = await import("../src/client/src/lib/confirm.js");
    replaceState({ avatars: [], chatPanes: [pane([userRow("u-1", "원래 질문"), assistantMessage()])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    await fireEvent.click(editButtons(container)[0]);
    await tick();
    const input = container.querySelector<HTMLTextAreaElement>("textarea.rewind-editor-input")!;
    await fireEvent.input(input, { target: { value: "고친 질문" } });
    await fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(get(confirmation)?.title).toBe("여기서부터 다시"));
    expect(get(confirmation)?.message).toContain("이후 메시지 1개와 거기에 딸린 첨부 파일·공유 링크가 삭제되며");
    resolveConfirmation(false);
    await tick();
    expect(readState().chatPanes[0].rewindEdit).toEqual({ messageId: "u-1", draft: "고친 질문" });

    await fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await tick();
    expect(readState().chatPanes[0].rewindEdit).toBeNull();
  });

  it("lets an image-only message go back with no text", async () => {
    const photo = { id: "img-1", kind: "image", mediaType: "image/png", name: "shot.png" };
    const imageOnly = { ...userRow("u-img", ""), attachments: [photo] } as unknown as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([imageOnly, assistantMessage()])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    await fireEvent.click(editButtons(container)[0]);
    await tick();
    const bubble = container.querySelector(".message.user .bubble") as HTMLElement;
    expect(bubble.querySelector("img.msg-image")).not.toBeNull();
    expect((within(bubble).getByRole("button", { name: "보내기" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the SAME bubble node when a sent message adopts the server's id — and through the run-end re-read", async () => {
    const stream = (frames: Array<[string, unknown]>) => {
      const enc = new TextEncoder();
      const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let i = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
          else controller.close();
        },
      });
    };
    const answer = { id: "srv-a", conversationId: "conv-1", role: "assistant", content: "새 답", createdAt: "2026-07-26T01:00:02.000Z", response: { kind: "text", runtime: "claude", summary: "완료", text: "새 답" } };
    // The stream is held until the optimistic bubble has been captured, so the
    // node compared below really predates `open` (and the id adoption).
    let releaseStream: () => void = () => {};
    const streamHeld = new Promise<void>((resolve) => (releaseStream = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === "/api/chat/stream") {
          await streamHeld;
          return {
            ok: true,
            status: 200,
            body: stream([
              ["open", { conversationId: "conv-1", runId: "r1", userMessageId: "srv-u" }],
              ["done", { message: answer }],
            ]),
            json: async () => ({}),
          };
        }
        // The run-end re-read returns the server's rows (ids the pane adopted).
        if (url.startsWith("/api/messages"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              messages: [{ ...userRow("srv-u", "고친 질문") }, { ...answer, response: { ...answer.response, summary: "재조회" } }],
              canvases: [],
            }),
          };
        return { ok: true, status: 200, json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }) };
      }),
    );
    const { confirmation, resolveConfirmation } = await import("../src/client/src/lib/confirm.js");
    const { startRewindEdit, setRewindEditDraft, submitRewindEdit } = await import("../src/client/src/lib/chat.js");
    replaceState({ avatars: [], chatPanes: [pane([userRow("u-1", "원래 질문"), assistantMessage()])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    startRewindEdit("pane-1", "u-1");
    setRewindEditDraft("pane-1", "고친 질문");
    const sending = submitRewindEdit("pane-1");
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);
    // The optimistic bubble, before `open` hands over the server's id.
    await waitFor(() => expect(container.querySelector(".message.user .bubble")?.textContent).toContain("고친 질문"));
    const optimisticId = readState().chatPanes[0].messages[0].id;
    expect(optimisticId).not.toBe("srv-u");
    const before = container.querySelector(".message.user");
    releaseStream();
    await sending;
    // Wait for the RE-READ itself (its copy is marked), not just the `done` frame.
    await waitFor(() => expect(readState().chatPanes[0].messages[1]?.response?.summary).toBe("재조회"));
    await tick();
    expect(readState().chatPanes[0].messages[0].id).toBe("srv-u");
    const after = container.querySelector(".message.user");
    expect(after).toBe(before);
    expect(before?.isConnected).toBe(true);
  });

  it("keeps an opened 생각 과정 card open when its bubble adopts the server's id", async () => {
    const stopped = { ...assistantMessage(), id: "client-stop" } as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([userRow("u-1", "질문"), stopped])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    const card = container.querySelector<HTMLDetailsElement>(".thinking-card")!;
    await clickSummary(card);
    await waitFor(() => expect(container.querySelector(".thinking-card-body")).not.toBeNull());
    // What adoption does to a client-made row: the id changes, the born-with id stays as its key.
    updateState((state) => {
      const row = state.chatPanes[0].messages[1] as StoredMessage & { clientKey?: string };
      row.clientKey = row.id;
      row.id = "srv-stop";
    });
    await tick();
    expect(container.querySelector(".thinking-card")).toBe(card);
    expect(container.querySelector(".thinking-card-body")?.textContent).toContain(THINKING);
  });

  it("hides 다시 생성 when the latest turn opener was queued behind another run", () => {
    replaceState({ avatars: [], chatPanes: [pane([userRow("u-q", "대기열 메시지", "queued"), assistantMessage()])], activePaneId: "pane-1" });
    const first = render(ChatView);
    expect(first.container.querySelector('button[aria-label="다시 생성"]')).toBeNull();
    first.unmount();

    replaceState({ avatars: [], chatPanes: [pane([userRow("u-1", "질문"), assistantMessage()])], activePaneId: "pane-1" });
    const second = render(ChatView);
    expect(second.container.querySelector('button[aria-label="다시 생성"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 공유 링크 beside a deck card                                         */
/* ------------------------------------------------------------------ */

describe("ChatView transcript · 공유 링크 beside a deck card", () => {
  const deck = {
    id: "deck-1",
    kind: "file",
    mediaType: PPTX_MEDIA_TYPE,
    name: "분기 보고.pptx",
    size: 4096,
    anchor: 0,
  };

  function deckMessage(attachments: unknown[] = [deck]): StoredMessage {
    return {
      ...assistantMessage(),
      id: "m-deck",
      content: "PPT를 만들었습니다.",
      attachments,
      response: { kind: "text", runtime: "claude", summary: "완료", text: "PPT를 만들었습니다." },
    } as unknown as StoredMessage;
  }

  it("puts the control BESIDE a stored PPTX card, as one flex item with it", () => {
    replaceState({ avatars: [], chatPanes: [pane([deckMessage()])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    const share = screen.getByRole("button", { name: "공유 링크: 분기 보고.pptx" });
    // Never nested in the card: the card is itself a <button>.
    expect(share.closest(".msg-file-card")).toBeNull();
    const pair = share.parentElement!;
    expect(pair.className).toContain("msg-file-share");
    expect(pair.querySelector(":scope > .msg-file-card")?.textContent).toContain("분기 보고.pptx");
    expect(pair.parentElement?.className).toContain("msg-images");
    expect(share.getAttribute("title")).toBe("공유 링크");
    expect(container.querySelectorAll(".msg-file-share")).toHaveLength(1);
  });

  it("opens the card's dialog from the control", async () => {
    replaceState({ avatars: [], chatPanes: [pane([deckMessage()])], activePaneId: "pane-1" });
    render(ChatView);
    await fireEvent.click(screen.getByRole("button", { name: "공유 링크: 분기 보고.pptx" }));
    expect(await screen.findByRole("dialog", { name: "공유 링크" })).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
        "/api/me/share-links?conversationId=conv-1&fileId=deck-1",
      ),
    );
  });

  it("keeps a dialog opened from the preview panel through a review canvas, then shows the new link", async () => {
    // The deck-review loop: round 2 streams in this pane while the owner shares
    // the STORED round-1 deck from the preview panel. The round ends with a
    // canvas that asks for input, which clears the preview (handleCanvas) — a
    // dialog rendered inside the panel went with it, mid-create included.
    const token = "A".repeat(43);
    const link = {
      id: "link-1",
      conversationId: "conv-1",
      conversationTitle: "PPT 만들기",
      fileId: "deck-1",
      fileName: "분기 보고.pptx",
      slideCount: 0,
      createdAt: "2026-09-29T00:00:00.000Z",
      expiresAt: "2026-10-06T00:00:00.000Z",
      expired: false,
      viewCount: 0,
      lastViewedAt: null,
      url: `/#/share/${token}`,
    };
    let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
    let releaseCreate: () => void = () => {};
    const createHeld = new Promise<void>((resolve) => (releaseCreate = resolve));
    const posts: string[] = [];
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/chat/runs/run-2/events")) {
          const body = new ReadableStream<Uint8Array>({ start: (controller) => void (sse = controller) });
          return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        if (url.startsWith("/api/me/share-links?")) return reply([]);
        if (init?.method === "POST" && url.endsWith("/share-links")) {
          posts.push(url);
          await createHeld;
          return reply({ link, created: true }, 201);
        }
        if (url.startsWith("/api/chat/runs?")) return reply({ run: null });
        return reply({ avatars: [], conversations: [], messages: [], skills: [] });
      }),
    );
    const frame = (event: string, data: unknown) =>
      sse!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    // A real pane (makePane) always carries these; the stream's handlers read them.
    const streamingPane = Object.assign(pane([deckMessage()]), { canvases: [], filePreview: null });
    replaceState({ avatars: [], chatPanes: [streamingPane], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    const run = attachRun("pane-1", "run-2");
    try {
      await waitFor(() => expect(sse).toBeTruthy());
      await fireEvent.click(container.querySelector(".msg-file-card")!);
      const panel = await waitFor(() => {
        const el = container.querySelector<HTMLElement>(".file-preview-panel");
        expect(el).toBeTruthy();
        return el!;
      });
      await fireEvent.click(within(panel).getByRole("button", { name: "공유 링크" }));
      const dialog = await screen.findByRole("dialog", { name: "공유 링크" });
      await fireEvent.click(await within(dialog).findByRole("button", { name: "공유 링크 만들기" }));
      await waitFor(() => expect(posts).toEqual(["/api/conversations/conv-1/files/deck-1/share-links"]));

      frame("canvas", {
        artifactId: "cv-r2",
        title: "2라운드 리뷰",
        content: "### 3번 슬라이드 – 매출 추이",
        contentType: "markdown",
        controls: [{ id: "r2-all", type: "text", label: "전체 수정 요청", required: false }],
        interaction: "async",
        runId: "run-2",
      });
      await waitFor(() => expect(readState().chatPanes[0].filePreview).toBeNull());
      await tick();
      expect(container.querySelector(".file-preview-panel")).toBeNull();
      // The SAME dialog, still mid-create…
      expect(screen.getByRole("dialog", { name: "공유 링크" })).toBe(dialog);
      expect(within(dialog).getByRole("button", { name: "만드는 중…" })).toBeTruthy();
      // …and it shows the link once the POST resolves.
      releaseCreate();
      const address = (await within(dialog).findByLabelText("링크 주소")) as HTMLInputElement;
      expect(address.value).toBe(`${location.origin}/#/share/${token}`);
    } finally {
      releaseCreate();
      readState().chatPanes[0]?.abortController?.abort();
      sse?.close();
      await run;
    }
  });

  it("waits for the turn to be stored: no control on a LIVE card", () => {
    const live = pane([]);
    (live as unknown as Record<string, unknown>).streaming = true;
    live.liveText = "PPT를 만드는 중";
    live.liveAttachments = [deck] as never;
    replaceState({ avatars: [], chatPanes: [live], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    expect(container.querySelector(".message.assistant .msg-file-card")?.textContent).toContain("분기 보고.pptx");
    expect(screen.queryByRole("button", { name: /^공유 링크/ })).toBeNull();
  });

  it("leaves other file cards exactly as they were", () => {
    const pdf = { id: "pdf-1", kind: "file", mediaType: "application/pdf", name: "보고.pdf", anchor: 0 };
    replaceState({ avatars: [], chatPanes: [pane([deckMessage([pdf])])], activePaneId: "pane-1" });
    const { container } = render(ChatView);
    expect(container.querySelector(".msg-file-share")).toBeNull();
    expect(container.querySelector(".msg-images > .msg-file-card")?.textContent).toContain("보고.pdf");
  });

  it("offers no control in a group agent's thread", () => {
    const groupPane = pane([deckMessage()]);
    groupPane.avatar = {
      ...avatar,
      id: "group:g1:a1",
      isOwn: false,
      groupAgent: { groupId: "g1", groupName: "팀" },
    } as unknown as AvatarDetail;
    replaceState({ avatars: [], chatPanes: [groupPane], activePaneId: "pane-1" });
    render(ChatView);
    expect(screen.queryByRole("button", { name: /^공유 링크/ })).toBeNull();
  });

  it("keeps the control in split view, where the card click downloads instead", () => {
    const second = { ...pane([]), id: "pane-2", conversationId: "conv-2" } as ChatPane;
    replaceState({ avatars: [], chatPanes: [pane([deckMessage()]), second], activePaneId: "pane-1" });
    render(ChatView);
    expect(screen.getByRole("button", { name: "공유 링크: 분기 보고.pptx" })).toBeTruthy();
  });
});
