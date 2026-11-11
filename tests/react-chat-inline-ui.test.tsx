// Inline UI: an avatar writes component tags straight into its ANSWER TEXT and
// the chat draws them in place — in the stored message, and in the live bubble
// while the text is still arriving (components/widget/AnswerUi.tsx, loaded
// lazily by ChatView). No canvas, no side panel, no tool call.
// Runs in the vitest "react" project (jsdom); a real browser covers layout
// and the streaming feel in tests/visual/inline-ui.spec.ts.
//
// These are the cases that go through ChatView; the cases that render AnswerUi
// by itself are tests/react-inline-ui.test.tsx.
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { resetCanvasRenderReports } from "../src/client/src/lib/canvasReport";
import { clearLiveWidgetState } from "../src/client/src/lib/widgetState";
import * as chat from "../src/client/src/lib/chat";
import { replaceState, updateState } from "../src/client/src/lib/state";
import type { ChatPane } from "../src/client/src/lib/types";
import type { AvatarDetail, StoredMessage } from "../src/server/types";

vi.mock("../src/client/src/lib/chat", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/chat")>()),
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

const CALC = `계산기를 만들었어요.

{@state n = 2}
{@const total = n * 3}
<box border padding={3} gap={2}>
  <slider label="수량" value={n} onChange={setN} min={0} max={10} />
  <text>합계 {total}개</text>
  <button send={\`수량 \${n}개로 주문해 줘\`}>이대로 주문</button>
  <submit values={{ n, total }}>값 보내기</submit>
</box>

값을 바꿔 보세요.
`;

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

function user(id: string, text: string): StoredMessage {
  return { id, conversationId: "conv-1", role: "user", content: text, createdAt: "2026-11-11T01:00:00.000Z", response: null } as unknown as StoredMessage;
}

function pane(messages: StoredMessage[], over: Record<string, unknown> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
    canvases: [],
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

/** Let what a store write or an event scheduled reach the DOM (an empty async `act`). */
const tick = (): Promise<void> => act(async () => {});

function show(chatPane: ChatPane) {
  // In `act`: one case shows a second pane while the first view is still mounted.
  act(() => replaceState({ avatars: [], chatPanes: [chatPane], activePaneId: "pane-1", user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]));
  return render(<ChatView />);
}

/** The inline UI components are a lazy chunk: wait for the first draw. */
async function uiDrawn(container: HTMLElement, selector = ".message.assistant .bubble > .answer-ui"): Promise<HTMLElement> {
  return waitFor(
    () => {
      const root = container.querySelector<HTMLElement>(selector);
      if (!root) throw new Error("the inline UI is not drawn yet");
      return root;
    },
    { timeout: 5000 },
  );
}

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }) }));

beforeEach(() => {
  localStorage.clear();
  resetCanvasRenderReports();
  clearLiveWidgetState("pane-1");
  vi.mocked(chat.sendWidgetMessage).mockClear();
  fetchMock.mockClear();
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
  vi.stubGlobal("fetch", fetchMock);
});

describe("inline UI in a stored answer", () => {
  it("is drawn in the bubble, between the answer's own Markdown — and nothing opens in the side panel", async () => {
    const { container } = show(pane([assistant("m-1", CALC)]));
    const ui = await uiDrawn(container);
    const flow = Array.from(container.querySelectorAll(".message.assistant .bubble > .md, .message.assistant .bubble > .answer-ui"));
    expect(flow.map((el) => el.className.split(" ")[0])).toEqual(["md", "wg-root", "md"]);
    expect(flow[0].textContent).toContain("계산기를 만들었어요.");
    expect(flow[2].textContent).toContain("값을 바꿔 보세요.");
    // The directives are not text of the answer, and the tags are real controls.
    expect(container.querySelector(".message.assistant .bubble")?.textContent).not.toContain("@state");
    expect(within(ui).getByRole("slider", { name: "수량" })).toBeTruthy();
    expect(ui.textContent).toContain("합계 6개");
    expect(container.querySelector(".canvas-panel")).toBeNull();
  });

  it("recomputes in the browser when an input changes, and keeps the value for this answer in this browser", async () => {
    const { container } = show(pane([assistant("m-1", CALC)]));
    const ui = await uiDrawn(container);
    fireEvent.change(within(ui).getByRole("slider", { name: "수량" }), { target: { value: "7" } });
    await waitFor(() => expect(ui.textContent).toContain("합계 21개"));
    // The avatar is not called for it.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/chat/stream"))).toBe(false);
    expect(chat.sendWidgetMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(localStorage.getItem("noah:inline-ui:u1:conv-1:m-1")).toBe(JSON.stringify({ n: { sig: "n = 2", value: 7 } })), { timeout: 2000 });
  });

  it("restores what this browser kept, per answer", async () => {
    localStorage.setItem("noah:inline-ui:u1:conv-1:m-1", JSON.stringify({ n: { sig: "n = 2", value: 5 } }));
    const { container } = show(pane([assistant("m-1", CALC), user("m-2", "다음"), assistant("m-3", CALC)]));
    await uiDrawn(container);
    const uis = Array.from(container.querySelectorAll<HTMLElement>(".message.assistant .bubble > .answer-ui"));
    expect(uis).toHaveLength(2);
    expect(uis[0].textContent).toContain("합계 15개");
    expect(uis[1].textContent).toContain("합계 6개");
  });

  it("a send button and a submit post the viewer's NEXT chat message — the text the control declared", async () => {
    const { container } = show(pane([assistant("m-1", CALC)]));
    const ui = await uiDrawn(container);
    fireEvent.change(within(ui).getByRole("slider", { name: "수량" }), { target: { value: "4" } });
    await waitFor(() => expect(ui.textContent).toContain("합계 12개"));
    fireEvent.click(within(ui).getByRole("button", { name: "이대로 주문" }));
    expect(chat.sendWidgetMessage).toHaveBeenLastCalledWith("pane-1", "수량 4개로 주문해 줘");
    fireEvent.click(within(ui).getByRole("button", { name: "값 보내기" }));
    expect(chat.sendWidgetMessage).toHaveBeenLastCalledWith("pane-1", "값 보내기\n- n: 4\n- total: 12", 10_000);
  });

  it("locks what goes to the avatar while the avatar is answering, and says why", async () => {
    const { container } = show(pane([assistant("m-1", CALC)], { streaming: true }));
    const ui = await uiDrawn(container);
    const submit = within(ui).getByRole("button", { name: "값 보내기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(chat.sendWidgetMessage).not.toHaveBeenCalled();
    expect(container.querySelector(".message.assistant .bubble > .wg-status")?.textContent).toBe("아바타 응답이 끝난 뒤 보낼 수 있습니다.");
    // Its own inputs keep working meanwhile.
    fireEvent.change(within(ui).getByRole("slider", { name: "수량" }), { target: { value: "1" } });
    await waitFor(() => expect(ui.textContent).toContain("합계 3개"));
  });

  it("draws a chart from the simple form, and a tag shown as SOURCE stays source", async () => {
    const text = [
      "매출입니다.",
      "",
      '<chart type="bar" data={[{ month: "1월", sales: 12 }, { month: "2월", sales: 15 }]} xKey="month" series={["sales"]} title="월별 매출" />',
      "",
      "소스는 이렇게 씁니다.",
      "",
      "```",
      '<chart type="bar" data={rows} />',
      "```",
    ].join("\n");
    const { container } = show(pane([assistant("m-1", text)]));
    const ui = await uiDrawn(container);
    expect(ui.querySelector(".wg-chart")).toBeTruthy();
    const code = container.querySelector(".message.assistant .bubble pre code");
    expect(code?.textContent).toContain('<chart type="bar" data={rows} />');
    expect(container.querySelectorAll(".message.assistant .bubble .wg-chart")).toHaveLength(1);
  });

  it("drops a tag or a prop that does not exist where it stands, and still draws the rest", async () => {
    const text = '<box shadow="lg">\n  <span>겉</span>\n  <fancy><text>안쪽 글</text></fancy>\n  <slider value={3} />\n</box>\n';
    const { container } = show(pane([assistant("m-1", text)]));
    const ui = await uiDrawn(container);
    expect(ui.textContent).toContain("겉");
    expect(ui.textContent).toContain("안쪽 글");
    // A slider without its label or handler is drawn (it does nothing) rather than replaced by an error.
    expect(ui.querySelector('input[type="range"]')).toBeTruthy();
    expect(ui.querySelector(".wg-error")).toBeNull();
  });

  it("tells the avatar what the LATEST answer could not draw, once, through the ui-report route", async () => {
    const broken = '<box>\n  <fancy><text>글</text></fancy>\n  <text>{nope(1)}</text>\n</box>\n';
    const { container } = show(pane([assistant("m-0", broken), user("m-1", "다시"), assistant("m-2", broken)]));
    await uiDrawn(container);
    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/conversations/conv-1/ui-report");
        if (!call) throw new Error("no report yet");
      },
      { timeout: 4000 },
    );
    const reports = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ui-report"));
    expect(reports).toHaveLength(1);
    const body = JSON.parse(String((reports[0][1] as RequestInit).body));
    expect(body.messageId).toBe("m-2");
    expect(body.errors.join("\n")).toMatch(/line 2:3 — Unknown component <fancy>/);
    expect(body.errors.join("\n")).toMatch(/nope/);
  });

  it("leaves an answer's own HTML and an ordinary answer to the Markdown renderer", async () => {
    const html = "<details><summary>접기</summary>\n\n본문입니다.\n\n</details>\n\n그냥 **답변**입니다.";
    const { container } = show(pane([assistant("m-1", html)]));
    // `<details>` at the start of a line makes the scan say "maybe"; the parser says it is HTML.
    await waitFor(() => expect(container.querySelector(".message.assistant .bubble > .md")?.innerHTML ?? "").toContain("<strong>답변</strong>"));
    expect(container.querySelector(".message.assistant .bubble details summary")?.textContent).toBe("접기");
    expect(container.querySelector(".answer-ui")).toBeNull();
    expect(container.querySelector(".widget-slot-pending")).toBeNull();
    // An answer with no tag at all never loads the renderer.
    const plain = show(pane([assistant("m-2", "그냥 **답변**입니다. a < b")]));
    await tick();
    expect(plain.container.querySelector(".message.assistant .bubble > .md")?.innerHTML).toContain("<strong>답변</strong>");
  });

  it("keeps a file card where it was anchored, around the UI", async () => {
    const first = "계산기를 만들었어요.";
    const card = { id: "file-1", kind: "file", name: "보고서.pdf", mediaType: "application/pdf", size: 10, anchor: first.length };
    const { container } = show(pane([assistant("m-1", CALC, [card])]));
    await uiDrawn(container);
    const flow = Array.from(container.querySelectorAll(".message.assistant .bubble > .md, .message.assistant .bubble > .answer-ui, .message.assistant .bubble > .msg-images"));
    expect(flow.map((el) => el.className.split(" ")[0])).toEqual(["md", "msg-images", "wg-root", "md"]);
  });
});

describe("inline UI while the answer is streaming", () => {
  const live = (text: string) => pane([user("m-0", "계산기 만들어 줘")], { streaming: true, liveRunId: "run-1", liveText: text });

  it("draws what has arrived: an open container shows its children so far, and the next tag holds its place", async () => {
    const upTo = (needle: string) => CALC.slice(0, CALC.indexOf(needle) + needle.length);
    const { container } = show(live(upTo("<text>합계 {total}개</text>\n")));
    const ui = await uiDrawn(container);
    expect(within(ui).getByRole("slider", { name: "수량" })).toBeTruthy();
    expect(ui.textContent).toContain("합계 6개");
    expect(ui.querySelector("button")).toBeNull();
    // Half a tag is never shown as text.
    await act(async () =>
      updateState((state) => {
        state.chatPanes[0].liveText = upTo("<button send={`수량");
      }),
    );
    expect(container.querySelector(".message.assistant .bubble")?.textContent).not.toContain("<button");
    // The rest arrives: the same UI grows, it is not replaced.
    await act(async () =>
      updateState((state) => {
        state.chatPanes[0].liveText = CALC;
      }),
    );
    await waitFor(() => expect(within(ui).getByRole("button", { name: "값 보내기" })).toBeTruthy());
    expect(container.querySelector<HTMLElement>(".message.assistant .bubble > .answer-ui")).toBe(ui);
  });

  it("holds a place for a top-level component whose tag is still being written", async () => {
    const { container } = show(live('매출입니다.\n\n<chart type="bar" data={[{ month: "1월", sa'));
    await waitFor(() => expect(container.querySelector(".message.assistant .bubble > .widget-slot-pending")?.textContent ?? "").toContain("차트를 그리는 중…"));
    expect(container.querySelector(".message.assistant .bubble > .md")?.textContent).toContain("매출입니다.");
    expect(container.querySelector(".message.assistant .bubble")?.textContent).not.toContain("<chart");
  });

  it("carries what the viewer set mid-stream over to the stored message when the turn ends", async () => {
    const { container } = show(live(CALC));
    const ui = await uiDrawn(container);
    fireEvent.change(within(ui).getByRole("slider", { name: "수량" }), { target: { value: "9" } });
    await waitFor(() => expect(ui.textContent).toContain("합계 27개"));
    // The turn ends: the live bubble goes and the stored message takes its place.
    await act(async () =>
      updateState((state) => {
        const p = state.chatPanes[0];
        p.streaming = false;
        p.liveText = "";
        p.liveRunId = null;
        p.messages.push(assistant("m-9", CALC));
      }),
    );
    await waitFor(() => {
      const stored = container.querySelector<HTMLElement>(".message.assistant .bubble > .answer-ui");
      if (!stored || !stored.textContent?.includes("합계 27개")) throw new Error("the stored answer did not take the value over");
    });
    await waitFor(() => expect(localStorage.getItem("noah:inline-ui:u1:conv-1:m-9")).toBe(JSON.stringify({ n: { sig: "n = 2", value: 9 } })), { timeout: 2000 });
  });
});

describe("what is left of the retired canvas widget", () => {
  it("its attachment draws nothing, and its canvas is a panel tab that shows the source", async () => {
    const att = { id: "cv1", kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", name: "계산기", anchor: 3 };
    const canvas = { id: "cv1", title: "계산기", content: "{@state n = 1}\n<text>{n}</text>", contentType: "widget" };
    const { container } = show(pane([assistant("m-1", "옛 답변입니다.", [att])], { canvases: [canvas] }));
    await tick();
    expect(container.querySelector(".message.assistant .bubble .msg-images")).toBeNull();
    const panel = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".canvas-panel .canvas-card");
      if (!el) throw new Error("no panel");
      return el;
    });
    await waitFor(() => expect(panel.querySelector(".canvas-render-error")?.textContent).toContain("더 이상 지원하지 않는 위젯 형식"));
    expect(panel.querySelector("pre")?.textContent).toContain("{@state n = 1}");
  });
});
