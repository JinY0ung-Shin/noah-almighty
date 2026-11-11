// ChatView's LIVE answer: drawn as markdown blocks whose finished nodes survive
// every token, revealed up to `$liveReveal`, with a reasoning card that says
// what it is doing without being parsed while closed.
//
// jsdom has no animation frames, so the real pacer never runs here; the store
// it publishes is swapped for one the test writes (the pacing itself is
// `client-stream-reveal.test.ts`, and a real browser covers the two together).
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { writable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reveal = vi.hoisted(() => ({ set: (_value: Record<string, number>) => {} }));
vi.mock("../src/client/src/lib/streamReveal.js", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  const { writable: makeStore } = await import("svelte/store");
  const store = makeStore<Record<string, number>>({});
  reveal.set = (value) => store.set(value);
  return { ...actual, liveReveal: { subscribe: store.subscribe } };
});

import ChatView from "../src/client/src/views/ChatView.svelte";
import { renderMarkdown } from "../src/client/src/lib/format.js";
import { replaceState, updateState } from "../src/client/src/lib/state.js";
import { noteThinking, resetThinkingClock } from "../src/client/src/lib/streamThinking.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";

void writable;

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
  visibility: "group",
  isOwn: true,
  elevated: true,
  plugins: [],
} as unknown as AvatarDetail;

function livePane(patch: Partial<ChatPane> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages: [],
    draft: "",
    streaming: true,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: "run-1",
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    ...patch,
  } as unknown as ChatPane;
}

function setLive(patch: (pane: ChatPane) => void): Promise<void> {
  updateState((state) => patch(state.chatPanes[0]));
  return tick();
}

async function clickSummary(card: HTMLDetailsElement): Promise<void> {
  await fireEvent.click(card.querySelector("summary")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

/** The bubble's html as a reader gets it: no caret, no enhancement chrome. */
function plainHtml(node: Element): string {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".stream-caret, .code-head").forEach((el) => el.remove());
  copy.querySelectorAll(".code-block, .table-wrap").forEach((wrapper) => wrapper.replaceWith(...Array.from(wrapper.childNodes)));
  return copy.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
}

/** Text of a rendered block run, without the newline marked ends every block with. */
function shownText(node: Element | null | undefined): string {
  return (node?.textContent ?? "").replace(/\n$/, "");
}

const ANSWER = "# 제목\n\n첫 문단은 **굵게** 끝난다.\n\n- 하나\n- 둘\n\n```ts\nconst a = 1;\n```\n\n마지막 문단";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
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
  reveal.set({});
  resetThinkingClock("pane-1");
  replaceState({ avatars: [], chatPanes: [livePane()], activePaneId: "pane-1" });
});

describe("ChatView live answer · blocks", () => {
  it("keeps finished blocks' nodes across tokens and ends on the whole render", async () => {
    const { container } = render(ChatView);
    let heading: Element | null = null;
    let firstParagraph: Element | null = null;
    for (let end = 1; end <= ANSWER.length; end += 1) {
      await setLive((pane) => {
        pane.liveText = ANSWER.slice(0, end);
      });
      const md = container.querySelector(".message.assistant .bubble > .md")!;
      if (end > ANSWER.indexOf("- 하나") + 2) {
        heading ??= md.querySelector("h1");
        firstParagraph ??= md.querySelector("p");
        expect(md.querySelector("h1")).toBe(heading);
        expect(md.querySelector("p")).toBe(firstParagraph);
      }
    }
    expect(heading).not.toBeNull();
    const md = container.querySelector(".message.assistant .bubble > .md")!;
    // Mid-stream the tail is healed; the last prefix IS the text, and complete.
    expect(plainHtml(md)).toBe(renderMarkdown(ANSWER));
    expect(md.querySelector(".stream-caret")).not.toBeNull();
    expect(md.lastElementChild?.classList.contains("stream-caret")).toBe(true);
    expect(md.querySelectorAll(".code-block")).toHaveLength(1);
    expect(md.querySelector(".code-lang")?.textContent).toBe("TypeScript");
  });

  it("never shows a raw marker for syntax that is still open", async () => {
    const { container } = render(ChatView);
    const text = () => shownText(container.querySelector(".message.assistant .bubble > .md"));
    await setLive((pane) => {
      pane.liveText = "값은 **굵";
    });
    expect(text()).toBe("값은 굵");
    expect(container.querySelector(".bubble > .md strong")?.textContent).toBe("굵");
    await setLive((pane) => {
      pane.liveText = "값은 **굵게** 그리고 [문서](https://exam";
    });
    expect(text()).toBe("값은 굵게 그리고 문서");
    await setLive((pane) => {
      pane.liveText = "| 이름 | 값";
    });
    expect(container.querySelector(".bubble > .md table th")?.textContent).toBe("이름");
    expect(text()).not.toContain("|");
  });

  it("restarts cleanly when the text folds away and a new block begins", async () => {
    const { container } = render(ChatView);
    await setLive((pane) => {
      pane.liveText = "첫 설명 문단\n\n둘째 문단\n\n셋째";
    });
    expect(container.querySelectorAll(".bubble > .md p")).toHaveLength(3);
    await setLive((pane) => {
      pane.liveThinking = pane.liveText;
      pane.liveText = "";
    });
    expect(container.querySelector(".message.assistant .bubble > .md")).toBeNull();
    await setLive((pane) => {
      pane.liveText = "새 답변";
    });
    const md = container.querySelector(".message.assistant .bubble > .md")!;
    expect(plainHtml(md)).toBe(renderMarkdown("새 답변"));
  });
});

describe("ChatView live answer · paced reveal", () => {
  it("shows only what the reveal has reached, and holds a card anchored beyond it", async () => {
    const first = "카드 앞의 글이 여기까지 있습니다.";
    replaceState({
      avatars: [],
      activePaneId: "pane-1",
      chatPanes: [
        livePane({
          liveText: `${first}\n\n카드 뒤의 글`,
          liveAttachments: [{ id: "f-1", kind: "file", mediaType: "application/pdf", name: "report.pdf", anchor: first.length }],
        } as Partial<ChatPane>),
      ],
    });
    reveal.set({ "pane-1": 6 });
    const { container } = render(ChatView);
    const bubble = container.querySelector(".message.assistant .bubble")!;
    expect(shownText(bubble.querySelector(":scope > .md"))).toBe(first.slice(0, 6));
    expect(bubble.textContent).not.toContain("report.pdf");

    reveal.set({ "pane-1": first.length });
    await tick();
    expect(bubble.textContent).toContain("report.pdf");
    expect(bubble.textContent).not.toContain("카드 뒤의 글");

    reveal.set({}); // nothing held: the text is all there
    await tick();
    const flow = Array.from(bubble.querySelectorAll(":scope > .md, :scope > .msg-images"));
    expect(flow.map((el) => el.textContent?.trim())).toEqual([first, expect.stringContaining("report.pdf"), "카드 뒤의 글"]);
  });

  it("a stale count from a longer text never clips or throws", async () => {
    reveal.set({ "pane-1": 500 });
    const { container } = render(ChatView);
    await setLive((pane) => {
      pane.liveText = "짧은 글";
    });
    expect(shownText(container.querySelector(".message.assistant .bubble > .md"))).toBe("짧은 글");
  });

  it("drains the end of a finished answer on the stored message, then hands over to the stored render", async () => {
    const text = "끝난 답변의 첫 문단입니다.\n\n둘째 문단까지 있습니다.";
    const message = {
      id: "m-done",
      conversationId: "conv-1",
      role: "assistant",
      content: text,
      createdAt: "2026-11-11T01:00:00.000Z",
      response: { kind: "text", runtime: "pi", summary: "완료", text },
    } as unknown as StoredMessage;
    replaceState({ avatars: [], activePaneId: "pane-1", chatPanes: [livePane({ streaming: false, messages: [message] } as Partial<ChatPane>)] });
    reveal.set({ "m:m-done": 9 });
    const { container } = render(ChatView);
    const md = () => container.querySelector(".message.assistant .bubble > .md")!;
    expect(shownText(md())).toBe(text.slice(0, 9));
    expect(md().querySelector(".stream-caret")).toBeNull();
    reveal.set({});
    await tick();
    expect(md().innerHTML).toBe(renderMarkdown(text));
  });
});

describe("ChatView live answer · reasoning card", () => {
  const THINKING = "**요구사항 정리**\n\n무엇을 보여 줄지 정한다.\n\n**구현 방식 비교**\n\n두 가지 길이 있다.";

  it("shows the sub-heading and the elapsed time on the closed card, without rendering the body", async () => {
    const { container } = render(ChatView);
    noteThinking("pane-1", true, Date.now() - 12_400);
    await setLive((pane) => {
      pane.liveThinking = THINKING;
      pane.thinkingActive = true;
    });
    const card = container.querySelector<HTMLDetailsElement>("details.thinking-card")!;
    expect(card.open).toBe(false);
    expect(card.querySelector(".thinking-card-hint")?.textContent).toBe("생각 중 · 구현 방식 비교");
    expect(card.querySelector(".thinking-card-time")?.textContent).toBe("12초");
    // Closed: the reasoning text is not parsed into the DOM at all.
    expect(container.querySelector(".thinking-card-body")).toBeNull();

    await clickSummary(card);
    const body = container.querySelector(".thinking-card-body")!;
    expect(body.querySelectorAll("strong")).toHaveLength(2);
    expect(body.textContent).toContain("두 가지 길이 있다.");
    const kept = body.querySelector("p");
    await setLive((pane) => {
      pane.liveThinking = `${THINKING} 더 살펴본다.`;
    });
    expect(body.textContent).toContain("더 살펴본다.");
    expect(body.querySelector("p")).toBe(kept); // finished blocks stay
    await clickSummary(card);
    expect(container.querySelector(".thinking-card-body")).toBeNull();
  });

  it("says how long it thought once the answer starts", async () => {
    const { container } = render(ChatView);
    const now = Date.now();
    noteThinking("pane-1", true, now - 7_300);
    await setLive((pane) => {
      pane.liveThinking = "생각했다.";
      pane.thinkingActive = true;
    });
    noteThinking("pane-1", false, now);
    await setLive((pane) => {
      pane.thinkingActive = false;
      pane.liveText = "답변 시작";
    });
    const card = container.querySelector("details.thinking-card")!;
    expect(card.querySelector(".thinking-card-hint")?.textContent).toBe("7초 동안 생각함");
    expect(card.querySelector(".thinking-card-spin")).toBeNull();
    expect(card.querySelector(".thinking-card-time")).toBeNull();
  });

  it("a stored card shows the duration only when the message carries one", () => {
    const base = {
      conversationId: "conv-1",
      role: "assistant",
      content: "답",
      createdAt: "2026-11-11T01:00:00.000Z",
    };
    const timed = { ...base, id: "m-1", response: { kind: "text", runtime: "pi", summary: "완료", text: "답", thinking: "생각", thinkingMs: 83_000 } };
    const untimed = { ...base, id: "m-2", response: { kind: "text", runtime: "pi", summary: "완료", text: "답", thinking: "생각" } };
    replaceState({
      avatars: [],
      activePaneId: "pane-1",
      chatPanes: [livePane({ streaming: false, messages: [timed, untimed] as unknown as StoredMessage[] } as Partial<ChatPane>)],
    });
    const { container } = render(ChatView);
    const cards = container.querySelectorAll("details.thinking-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector(".thinking-card-hint")?.textContent).toBe("1분 23초 동안 생각함");
    expect(cards[1].querySelector(".thinking-card-hint")).toBeNull();
  });
});
