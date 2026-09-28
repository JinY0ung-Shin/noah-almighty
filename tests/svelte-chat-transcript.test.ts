// ChatView transcript rendering. Guards the deferred-card behavior that keeps a
// long transcript cheap: <details> only HIDES its children, so leaving the
// "생각 과정" body and the "작업 내역" tree in the template cost a markdown parse
// and an ActivityTree mount for EVERY message on load. Both now render on first
// open. See lib/format.ts renderMarkdownCached for the matching per-token fix.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { attachRun } from "../src/client/src/lib/chat.js";
import { readState, replaceState } from "../src/client/src/lib/state.js";
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
