// ChatView — the transcript's stick-to-bottom controller follows the PANE.
//
// In the single-pane layout one `.transcript` element serves whichever pane is
// shown. When the pane is replaced (a new chat, another conversation) the
// element has to be handed to the new pane's controller; while it was left with
// the old one, a wheel-up never detached, 맨 아래로 never appeared and a
// streamed answer pulled the reader back down (seen in a real browser,
// 2026-11-12). jsdom has no layout, so the transcript is given a scrollable
// size by hand; the real scrolling is the Playwright suite's.
//
// Runs in the vitest "react" project.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { ChatPane } from "../src/client/src/lib/types";
import type { AvatarDetail, StoredMessage } from "../src/server/types";

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

function pane(id: string): ChatPane {
  const message = {
    id: `${id}-m1`,
    conversationId: `${id}-conv`,
    role: "assistant",
    content: "긴 답변",
    createdAt: "2026-07-26T01:00:00.000Z",
    response: { kind: "text", runtime: "pi", summary: "완료", text: "긴 답변" },
  } as unknown as StoredMessage;
  return {
    id,
    avatar,
    conversationId: `${id}-conv`,
    messages: [message],
    draft: "",
    streaming: false,
    stickBottom: true,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
  } as unknown as ChatPane;
}

/** Make the (layout-less) transcript look scrollable, scrolled to the bottom. */
function transcript(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".transcript")!;
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: 500 });
  return node;
}

const stuck = (id: string): boolean | undefined => readState().chatPanes.find((p) => p.id === id)?.stickBottom;

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true) })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }) })),
  );
  replaceState({ view: "chat", avatars: [], chatPanes: [pane("pane-1")], activePaneId: "pane-1" });
});

describe("ChatView stick-to-bottom across a pane swap", () => {
  it("detaches on wheel-up and offers 맨 아래로 for the pane it opened with", async () => {
    render(<ChatView />);
    await act(async () => {});
    const node = transcript();

    await act(async () => {
      fireEvent.wheel(node, { deltaY: -120 });
    });

    expect(stuck("pane-1")).toBe(false);
    expect(screen.getByRole("button", { name: "맨 아래로" })).toBeTruthy();
  });

  it("hands the same transcript element to the pane that REPLACED it", async () => {
    render(<ChatView />);
    await act(async () => {});
    const before = transcript();

    // A new chat / another conversation in the single pane: a new pane id.
    await act(async () => replaceState({ chatPanes: [pane("pane-2")], activePaneId: "pane-2" }));
    const node = transcript();
    expect(node).toBe(before); // the element is reused — which is why it has to be re-bound

    await act(async () => {
      fireEvent.wheel(node, { deltaY: -120 });
    });
    expect(stuck("pane-2")).toBe(false);

    // 맨 아래로 re-arms the stick of the pane on screen.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "맨 아래로" }));
    });
    expect(stuck("pane-2")).toBe(true);
    expect(screen.queryByRole("button", { name: "맨 아래로" })).toBeNull();
  });

  it("keeps following after a second swap, and never writes to a pane that is gone", async () => {
    render(<ChatView />);
    await act(async () => {});
    await act(async () => replaceState({ chatPanes: [pane("pane-2")], activePaneId: "pane-2" }));
    await act(async () => replaceState({ chatPanes: [pane("pane-3")], activePaneId: "pane-3" }));

    await act(async () => {
      fireEvent.wheel(transcript(), { deltaY: -120 });
    });

    expect(readState().chatPanes.map((p) => [p.id, p.stickBottom])).toEqual([["pane-3", false]]);
  });
});
