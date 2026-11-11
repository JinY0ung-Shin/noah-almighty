// A `widget` canvas is drawn IN the chat bubble of the answer that showed it —
// where its `kind: "widget"` attachment is anchored — not in the side panel.
// Runs in the vitest "components" project (jsdom); a real browser covers layout,
// CSP and focus in tests/visual/canvas-widget.spec.ts.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { resetCanvasRenderReports } from "../src/client/src/lib/canvasReport.js";
import * as chat from "../src/client/src/lib/chat.js";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";
import { checkWidget } from "../src/shared/widget/index.js";

vi.mock("../src/client/src/lib/chat.js", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/chat.js")>()),
  submitCanvas: vi.fn(async () => {}),
  sendWidgetMessage: vi.fn(async () => true),
}));

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

const CALC = `{@state n = 2}

<slider label="수량" value={n} onChange={setN} min={0} max={10} />
<text>합계 {n * 2}개</text>
<submit values={{ n }}>이 수량으로 진행</submit>
`;

function widgetSource(source: string): string {
  const check = checkWidget(source);
  expect(check, check.ok ? "" : check.error).toMatchObject({ ok: true });
  return source;
}

const widgetAttachment = (id: string, anchor?: number, name = "계산기") =>
  ({ id, kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", name, ...(anchor === undefined ? {} : { anchor }) }) as any;

function assistant(id: string, text: string, attachments: unknown[] = []): StoredMessage {
  return {
    id,
    conversationId: "conv-1",
    role: "assistant",
    content: text,
    createdAt: "2026-11-11T01:00:00.000Z",
    attachments: attachments.length ? attachments : undefined,
    response: { kind: "text", runtime: "pi", summary: "완료", text },
  } as unknown as StoredMessage;
}

function widgetCanvas(id: string, content: string, over: Record<string, unknown> = {}) {
  return { id, title: "계산기", content, contentType: "widget", interaction: "async", ...over };
}

function pane(messages: StoredMessage[], canvases: unknown[], over: Record<string, unknown> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
    canvases,
    fileTabs: [],
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
    ...over,
  } as unknown as ChatPane;
}

function show(chatPane: ChatPane) {
  replaceState({ avatars: [], chatPanes: [chatPane], activePaneId: "pane-1", user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
  return render(ChatView);
}

/** The widget library is a lazy chunk: wait for the first draw. */
async function widgetDrawn(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const root = container.querySelector<HTMLElement>(".message.assistant .bubble .canvas-inline .wg-root");
    if (!root) throw new Error("the inline widget is not drawn yet");
    return root;
  });
}

beforeEach(() => {
  localStorage.clear();
  resetCanvasRenderReports();
  vi.mocked(chat.submitCanvas).mockClear();
  vi.mocked(chat.sendWidgetMessage).mockClear();
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
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }) })),
  );
});

describe("a widget canvas in the chat bubble", () => {
  it("is drawn where its attachment is anchored, with the following text below it — and not in the side panel", async () => {
    const first = "계산기를 만들었어요.";
    const rest = "값을 바꿔 보세요.";
    const text = `${first}\n\n${rest}`;
    const { container } = show(pane([assistant("m-1", text, [widgetAttachment("cv1", first.length)])], [widgetCanvas("cv1", widgetSource(CALC))]));
    await widgetDrawn(container);

    const flow = Array.from(container.querySelectorAll(".message.assistant .bubble > .md, .message.assistant .bubble > .msg-images"));
    expect(flow).toHaveLength(3);
    expect(flow[0].textContent).toContain(first);
    expect(flow[0].textContent).not.toContain(rest);
    expect(flow[1].querySelector(".canvas-card.canvas-inline .wg-root")).toBeTruthy();
    expect(flow[2].textContent).toContain(rest);
    // The widget's own Markdown-free content sits outside the prose container: no `.md` rule reaches it.
    expect(flow[1].closest(".md")).toBeNull();
    expect(flow[1].querySelector(".canvas-content")?.classList.contains("md")).toBe(false);
    // Nothing in the side panel: it is not even mounted for a pane whose only canvas is inline.
    expect(container.querySelector(".canvas-panel")).toBeNull();

    // It works right there: local recompute, the tools of a canvas (fullscreen among them), submit.
    const bubble = container.querySelector(".message.assistant .bubble") as HTMLElement;
    await fireEvent.input(within(bubble).getByRole("slider", { name: "수량" }), { target: { value: "7" } });
    await tick();
    expect(within(bubble).getByText("합계 14개")).toBeTruthy();
    expect(within(bubble).getByRole("button", { name: "전체화면" })).toBeTruthy();
    expect(within(bubble).getByRole("button", { name: "캔버스 삭제" })).toBeTruthy();
    await fireEvent.click(within(bubble).getByRole("button", { name: "이 수량으로 진행" }));
    expect(vi.mocked(chat.submitCanvas).mock.calls[0]).toEqual(["pane-1", "cv1", { n: 7 }]);
  });

  it("is alive in ONE place: the newest answer that carries it; earlier ones say where it went", async () => {
    const messages = [
      assistant("m-1", "첫 버전입니다.", [widgetAttachment("cv1")]),
      { id: "u-2", conversationId: "conv-1", role: "user", content: "더 크게", response: null, createdAt: "2026-11-11T01:01:00.000Z" } as unknown as StoredMessage,
      assistant("m-2", "고쳤어요.", [widgetAttachment("cv1")]),
    ];
    const { container } = show(pane(messages, [widgetCanvas("cv1", widgetSource(CALC), { currentVersion: 2, versionCount: 2 })]));
    await widgetDrawn(container);

    const bubbles = container.querySelectorAll(".message.assistant .bubble");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].querySelector(".wg-root")).toBeNull();
    expect(bubbles[0].querySelector(".widget-slot-note")?.textContent).toBe("「계산기」 위젯은 아래 답변에서 갱신됐습니다.");
    expect(bubbles[1].querySelector(".canvas-inline .wg-root")).toBeTruthy();
    expect(container.querySelectorAll(".wg-root")).toHaveLength(1);
    expect(container.querySelector(".canvas-panel")).toBeNull();
  });

  it("says so when the canvas is gone, and keeps another canvas type out of the bubble", () => {
    const messages = [assistant("m-1", "위젯", [widgetAttachment("cv-gone", undefined, "지워진 것"), widgetAttachment("cv-md", undefined, "문서")])];
    const { container } = show(pane(messages, [{ id: "cv-md", title: "문서", content: "# 제목", contentType: "markdown" }]));
    const notes = Array.from(container.querySelectorAll(".widget-slot-note")).map((el) => el.textContent);
    expect(notes).toEqual(["「지워진 것」 위젯은 삭제되어 더 이상 볼 수 없습니다.", "「문서」은 캔버스로 바뀌어 오른쪽 패널에 있습니다."]);
    expect(container.querySelector(".message .wg-root")).toBeNull();
    // The markdown canvas is where it always was.
    expect(within(container.querySelector(".canvas-panel") as HTMLElement).getByRole("tab", { name: "문서" })).toBeTruthy();
  });

  it("keeps a widget WITHOUT an attachment as a panel tab (older conversations), next to the other canvas types", async () => {
    const messages = [assistant("m-1", "새 위젯", [widgetAttachment("cv-new")])];
    const canvases = [
      widgetCanvas("cv-old", widgetSource(CALC), { title: "예전 위젯" }),
      { id: "cv-chart", title: "차트", content: "{}", contentType: "vega" },
      widgetCanvas("cv-new", widgetSource(CALC), { title: "새 위젯" }),
    ];
    const { container } = show(pane(messages, canvases));
    await widgetDrawn(container);
    const panel = container.querySelector(".canvas-panel") as HTMLElement;
    expect(within(panel).getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual(["예전 위젯", "차트"]);
    // The inline one is not a tab, and is not drawn twice.
    expect(container.querySelector(".message.assistant .bubble .canvas-inline")).toBeTruthy();
    expect(panel.querySelector(".canvas-inline")).toBeNull();
  });

  it("removing the canvas leaves a note in its place", async () => {
    const chatPane = pane([assistant("m-1", "위젯", [widgetAttachment("cv1")])], [widgetCanvas("cv1", widgetSource(CALC))]);
    const { container } = show(chatPane);
    await widgetDrawn(container);
    // What deleteCanvas does to the pane once the server confirmed.
    replaceState({ chatPanes: [{ ...chatPane, canvases: [] }] } as unknown as Parameters<typeof replaceState>[0]);
    await waitFor(() => expect(container.querySelector(".widget-slot-note")?.textContent).toContain("삭제되어 더 이상 볼 수 없습니다"));
    expect(container.querySelector(".wg-root")).toBeNull();
  });
});

describe("a live turn that shows a widget", () => {
  function liveHarness() {
    let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/chat/runs/run-w/events")) {
          const body = new ReadableStream<Uint8Array>({ start: (controller) => void (sse = controller) });
          return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        if (url.startsWith("/api/chat/runs?")) return reply({ run: null });
        return reply({ avatars: [], conversations: [], messages: [], skills: [] });
      }),
    );
    const frame = (event: string, data: unknown) => sse!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    // The run loop ends only when its stream does: abort the pane AND close the stream.
    const stop = () => {
      readState().chatPanes[0]?.abortController?.abort();
      try {
        sse?.close();
      } catch {
        /* already closed */
      }
    };
    return { frame, stop, ready: () => waitFor(() => expect(sse).toBeTruthy()) };
  }

  it("holds the place while the avatar builds it, then draws it there — the side panel never opens", async () => {
    const { frame, ready, stop } = liveHarness();
    const { container } = show(pane([], []));
    const run = chat.attachRun("pane-1", "run-w");
    try {
      await ready();
      frame("delta", { text: "계산기를 만들게요." });
      frame("tool", { toolUseId: "t-1", name: "mcp__canvas__show", input: { title: "계산기", contentType: "widget" } });
      const live = () => container.querySelector(".message.assistant .bubble") as HTMLElement;
      await waitFor(() => expect(live()?.querySelector(".widget-slot-pending")?.textContent).toContain("위젯을 만드는 중…"));
      expect(live().querySelector(".widget-slot-pending")?.getAttribute("role")).toBe("status");

      // The canvas frame arrives first; the attachment that places it follows.
      frame("canvas", { artifactId: "cv-live", title: "계산기", content: widgetSource(CALC), contentType: "widget", interaction: "async", runId: "run-w" });
      await waitFor(() => expect(readState().chatPanes[0].canvases).toHaveLength(1));
      await tick();
      expect(container.querySelector(".canvas-panel")).toBeNull(); // not even for a moment
      expect(readState().chatPanes[0].sideTab ?? null).toBeNull();
      expect(live().querySelector(".widget-slot-pending")).toBeTruthy(); // still held

      frame("file", { runId: "run-w", attachment: widgetAttachment("cv-live") });
      await widgetDrawn(container);
      expect(live().querySelector(".widget-slot-pending")).toBeNull();
      expect(container.querySelector(".canvas-panel")).toBeNull();
      frame("tool_end", { toolUseId: "t-1", ok: true });
      frame("delta", { text: "값을 바꿔 보세요." });
      // The text that follows streams BELOW the widget.
      await waitFor(() => {
        const flow = Array.from(live().querySelectorAll(":scope > .md, :scope > .msg-images"));
        expect(flow.map((el) => (el.classList.contains("md") ? "text" : "widget"))).toEqual(["text", "widget", "text"]);
        expect(flow[2].textContent).toContain("값을 바꿔 보세요.");
      });
      expect(within(live()).getByRole("slider", { name: "수량" })).toBeTruthy();
    } finally {
      stop();
      await run.catch(() => {});
    }
  });

  it("shows no placeholder for a canvas that goes to the panel, and a neutral one when the type is not known", async () => {
    const { frame, ready, stop } = liveHarness();
    const { container } = show(pane([], []));
    const run = chat.attachRun("pane-1", "run-w");
    try {
      await ready();
      frame("delta", { text: "차트를 그릴게요." });
      frame("tool", { toolUseId: "t-1", name: "mcp__canvas__show", input: { title: "차트", contentType: "markdown" } });
      frame("tool", { toolUseId: "t-2", name: "mcp__canvas__show" });
      const live = () => container.querySelector(".message.assistant .bubble") as HTMLElement;
      await waitFor(() => expect(live()?.querySelectorAll(".widget-slot-pending")).toHaveLength(1));
      expect(live().querySelector(".widget-slot-pending")?.textContent).toContain("캔버스를 준비하는 중…");
      // The canvas lands in the panel: the placeholder is gone and the panel has it.
      frame("canvas", { artifactId: "cv-md", title: "차트", content: "# 표", contentType: "markdown", runId: "run-w" });
      await waitFor(() => expect(live().querySelector(".widget-slot-pending")).toBeNull());
      expect(within(container.querySelector(".canvas-panel") as HTMLElement).getByRole("tab", { name: "차트" })).toBeTruthy();
    } finally {
      stop();
      await run.catch(() => {});
    }
  });
});

describe("what a widget may do to the conversation", () => {
  const ACTIONS = `{@state topic = "매출"}
{@state slash = "/"}

<input label="주제" value={topic} onChange={setTopic} />
<row>
  <button send={topic + " 요약해 줘"}>요약 요청</button>
  <button send={slash + "new"}>새 대화</button>
  <button href="https://wiki.example.com/guide?x=1">가이드 열기</button>
  <button onClick={() => setTopic("비용")}>비용으로</button>
</row>
<text>자세한 내용은 <link href="https://wiki.example.com/a">위키</link>와 [문서](https://docs.example.com/b)를 보세요.</text>
<link href="https://wiki.example.com/solo">따로 놓인 링크</link>
<image src="/api/conversations/conv-1/images/img-1" alt="이 대화의 그림" width={120} maxHeight={90} radius="md" fit="cover" />
<image src="/api/conversations/other-conv/images/img-9" alt="남의 그림" />
`;

  async function mount(over: Record<string, unknown> = {}) {
    const view = show(pane([assistant("m-1", "위젯", [widgetAttachment("cv1")])], [widgetCanvas("cv1", widgetSource(ACTIONS), { interaction: undefined })], over));
    const root = await widgetDrawn(view.container);
    return { ...view, root };
  }

  it("a send button says what it will send, and sends it as the viewer's next message", async () => {
    const { root } = await mount();
    const send = within(root).getByRole("button", { name: "요약 요청" }) as HTMLButtonElement;
    expect(send.getAttribute("title")).toBe("보낼 메시지: 매출 요약해 줘");
    // The same sentence for a screen reader, next to the lock status.
    const described = (send.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described[0]).toBe("보낼 메시지: 매출 요약해 줘");
    expect(send.disabled).toBe(false);

    // It follows the widget's state: what is shown is what goes out.
    await fireEvent.input(within(root).getByRole("textbox", { name: "주제" }), { target: { value: "재고" } });
    await tick();
    expect(send.getAttribute("title")).toBe("보낼 메시지: 재고 요약해 줘");
    await fireEvent.click(send);
    expect(vi.mocked(chat.sendWidgetMessage).mock.calls).toEqual([["pane-1", "재고 요약해 줘"]]);

    // A message that would run as a slash command is never sent from a widget:
    // the static check refuses a literal one, and one COMPUTED at run time (as
    // here) leaves a button that does nothing and says so.
    const slash = within(root).getByRole("button", { name: "새 대화" }) as HTMLButtonElement;
    expect(slash.disabled).toBe(true);
    expect(slash.getAttribute("title")).toMatch(/^(슬래시\(\/\)로 시작하는 메시지는 위젯에서 보낼 수 없습니다\.|이 버튼은 동작하지 않습니다)/);
    await fireEvent.click(slash);
    expect(chat.sendWidgetMessage).toHaveBeenCalledTimes(1);
  });

  it("a send button waits for the avatar's turn to end", async () => {
    const { root } = await mount({ streaming: true, liveRunId: "run-x" });
    const send = within(root).getByRole("button", { name: "요약 요청" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(root.querySelector(".wg-status")?.textContent).toBe("아바타 응답이 끝난 뒤 보낼 수 있습니다.");
    await fireEvent.click(send);
    expect(chat.sendWidgetMessage).not.toHaveBeenCalled();
    // A local handler needs no turn.
    await fireEvent.click(within(root).getByRole("button", { name: "비용으로" }));
    await tick();
    expect((within(root).getByRole("textbox", { name: "주제" }) as HTMLInputElement).value).toBe("비용");
  });

  it("links open in a new tab, show where they go, and are only ever http(s)", async () => {
    const { root } = await mount();
    const anchors = Array.from(root.querySelectorAll("a"));
    expect(anchors.map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual([
      ["가이드 열기", "https://wiki.example.com/guide?x=1"],
      ["위키", "https://wiki.example.com/a"],
      ["문서", "https://docs.example.com/b"],
      ["따로 놓인 링크", "https://wiki.example.com/solo"],
    ]);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("title")).toBe(a.getAttribute("href"));
    }
    // The button-link keeps the button look; the text around an inline link stays text.
    expect(anchors[0].classList.contains("btn")).toBe(true);
    expect(root.querySelector(".wg-text")?.textContent).toBe("자세한 내용은 위키와 문서를 보세요.");
  });

  it("shows an image of THIS conversation and refuses another conversation's", async () => {
    const { root } = await mount();
    const images = Array.from(root.querySelectorAll("img"));
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe("/api/conversations/conv-1/images/img-1");
    expect(images[0].getAttribute("alt")).toBe("이 대화의 그림");
    expect(images[0].getAttribute("loading")).toBe("lazy");
    expect(images[0].getAttribute("style")).toMatch(/width:\s*120px/);
    expect(images[0].getAttribute("style")).toMatch(/max-height:\s*90px/);
    expect(images[0].getAttribute("style")).toMatch(/object-fit:\s*cover/);
    // The other one is an error in place — and no request for it is ever made.
    const errors = Array.from(root.querySelectorAll(".wg-error")).filter((el) => (el.getAttribute("title") ?? "").includes("another conversation"));
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toBe("이 부분을 표시하지 못했습니다.");
    expect(root.innerHTML).not.toContain("other-conv");
  });
});
