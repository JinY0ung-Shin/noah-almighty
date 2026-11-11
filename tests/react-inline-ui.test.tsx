// Inline UI: an avatar writes component tags straight into its ANSWER TEXT and
// the chat draws them in place — in the stored message, and in the live bubble
// while the text is still arriving (components/widget/AnswerUi.tsx, loaded
// lazily by ChatView). No canvas, no side panel, no tool call.
// Runs in the vitest "react" project (jsdom); a real browser covers layout
// and the streaming feel in tests/visual/inline-ui.spec.ts.
//
// The React port of the cases of tests/svelte-chat-inline-ui.test.ts that
// render AnswerUi by itself; the cases that go through ChatView move with
// ChatView.
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AnswerUi from "../src/client/src/components/widget/AnswerUi";
import { resetCanvasRenderReports } from "../src/client/src/lib/canvasReport.js";
import { clearLiveWidgetState } from "../src/client/src/lib/widgetState.js";
import * as chat from "../src/client/src/lib/chat.js";
import { replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";

vi.mock("../src/client/src/lib/chat.js", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/chat.js")>()),
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

// The component by itself: what the live bubble and the stored message hand to each other.
describe("AnswerUi across the end of a turn", () => {
  const BROKEN = "<box>\n  <fancy><text>글</text></fancy>\n  <text>{nope(1)}</text>\n</box>\n";
  const OTHER = `다른 답변입니다.\n\n{@state n = 2}\n<slider label="수량" value={n} onChange={setN} min={0} max={10} />\n<text>합계 {n * 3}개</text>\n`;
  const FORM = `{@state name = ""}\n<input label="이름" value={name} onChange={setName} />\n<text>안녕하세요 {name}</text>\n`;
  const livePane = pane([], { streaming: true, liveRunId: "run-1" });
  const idlePane = pane([]);
  const signIn = () => replaceState({ avatars: [], chatPanes: [], activePaneId: "pane-1", user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
  const reportCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/ui-report"));

  it("reports what it could not draw once the answer's end has drained in — not only when it mounts finished", async () => {
    signIn();
    const view = render(<AnswerUi pane={idlePane} text={BROKEN.slice(0, 30)} streaming={true} messageId="m-2" latest={true} />);
    await act(async () => {});
    view.rerender(<AnswerUi pane={idlePane} text={BROKEN} streaming={true} messageId="m-2" latest={true} />);
    // The reveal catches up: the same instance, now finished.
    view.rerender(<AnswerUi pane={idlePane} text={BROKEN} streaming={false} messageId="m-2" latest={true} />);
    await waitFor(() => expect(reportCalls()).toHaveLength(1), { timeout: 4000 });
    const body = JSON.parse(String((reportCalls()[0][1] as RequestInit).body));
    expect(body.messageId).toBe("m-2");
    expect(body.errors.join("\n")).toMatch(/Unknown component <fancy>/);
    // While it was still streaming nothing went out.
    expect(body.errors.join("\n")).not.toMatch(/never closed|never finished/);
  });

  it("an answer that becomes the latest one later reports then", async () => {
    signIn();
    const view = render(<AnswerUi pane={idlePane} text={BROKEN} messageId="m-1" latest={false} />);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(reportCalls()).toHaveLength(0);
    view.rerender(<AnswerUi pane={idlePane} text={BROKEN} messageId="m-1" latest={true} />);
    await waitFor(() => expect(reportCalls()).toHaveLength(1), { timeout: 4000 });
  });

  it("hands the live answer's state only to the stored answer it became, and back to its own run's bubble", async () => {
    signIn();
    const live = render(<AnswerUi pane={livePane} text={CALC} streaming={true} />);
    fireEvent.change(within(live.container).getByRole("slider", { name: "수량" }), { target: { value: "9" } });
    await waitFor(() => expect(live.container.textContent).toContain("합계 27개"));
    // The chat view is left mid-stream…
    live.unmount();
    // …and on the way back an OLDER answer with the same declaration mounts first: not its state.
    const older = render(<AnswerUi pane={livePane} text={OTHER} messageId="m-old" latest={false} />);
    await act(async () => {});
    expect(older.container.textContent).toContain("합계 6개");
    // The live bubble of the same run picks its state up again.
    const again = render(<AnswerUi pane={livePane} text={CALC} streaming={true} />);
    await waitFor(() => expect(again.container.textContent).toContain("합계 27개"));
    again.unmount();
    // The turn ends: the stored answer that continues the live text takes it, and keeps it.
    const stored = render(<AnswerUi pane={idlePane} text={CALC} messageId="m-new" latest={true} />);
    await waitFor(() => expect(stored.container.textContent).toContain("합계 27개"));
    await waitFor(() => expect(localStorage.getItem("noah:inline-ui:u1:conv-1:m-new")).toBe(JSON.stringify({ n: { sig: "n = 2", value: 9 } })), { timeout: 2000 });
    expect(localStorage.getItem("noah:inline-ui:u1:conv-1:m-old")).toBeNull();
    // A live bubble of ANOTHER run starts clean.
    const next = render(<AnswerUi pane={pane([], { streaming: true, liveRunId: "run-2" })} text={CALC} streaming={true} />);
    await act(async () => {});
    expect(next.container.textContent).toContain("합계 6개");
  });

  it("gives the focus back to the field the viewer was typing in when the stored message replaces the live bubble", async () => {
    signIn();
    const live = render(<AnswerUi pane={livePane} text={FORM} streaming={true} />);
    const field = within(live.container).getByRole("textbox", { name: "이름" }) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "김" } });
    await waitFor(() => expect(live.container.textContent).toContain("안녕하세요 김"));
    live.unmount();
    expect(document.activeElement).toBe(document.body);
    const stored = render(<AnswerUi pane={idlePane} text={FORM} messageId="m-form" latest={true} />);
    const again = await waitFor(() => within(stored.container).getByRole("textbox", { name: "이름" }) as HTMLInputElement);
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(again.value).toBe("김");
  });

  it("moves what it stored when a client-made message id is replaced by the server's", async () => {
    signIn();
    const view = render(<AnswerUi pane={idlePane} text={CALC} messageId="local-1" latest={true} />);
    fireEvent.change(within(view.container).getByRole("slider", { name: "수량" }), { target: { value: "8" } });
    await waitFor(() => expect(localStorage.getItem("noah:inline-ui:u1:conv-1:local-1")).not.toBeNull(), { timeout: 2000 });
    view.rerender(<AnswerUi pane={idlePane} text={CALC} messageId="srv-1" latest={true} />);
    await waitFor(() => expect(localStorage.getItem("noah:inline-ui:u1:conv-1:srv-1")).toBe(JSON.stringify({ n: { sig: "n = 2", value: 8 } })), { timeout: 2000 });
    expect(localStorage.getItem("noah:inline-ui:u1:conv-1:local-1")).toBeNull();
  });
});
