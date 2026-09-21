// ChatView transcript rendering. Guards the deferred-card behavior that keeps a
// long transcript cheap: <details> only HIDES its children, so leaving the
// "생각 과정" body and the "작업 내역" tree in the template cost a markdown parse
// and an ActivityTree mount for EVERY message on load. Both now render on first
// open. See lib/format.ts renderMarkdownCached for the matching per-token fix.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";

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
