// Typing in the composer (or the 여기서부터 다시 editor) redraws the field — not
// the transcript. A keystroke writes the draft in place and bumps the draft
// channel (lib/chatDrafts.ts) instead of publishing the app state, which would
// redraw every MessageRow. The probe: MessageRow formats each row's time with
// `timeLabel` on every render, so its call count IS the number of row renders.
//
// Runs in the vitest "react" project.
import { act, fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { timeLabel } from "../src/client/src/lib/format";
import { readState, replaceState, toasts, updateState } from "../src/client/src/lib/state";
import type { ChatPane } from "../src/client/src/lib/types";
import type { AvatarDetail, StoredMessage } from "../src/server/types";

vi.mock("../src/client/src/lib/format", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/client/src/lib/format")>();
  return { ...real, timeLabel: vi.fn(real.timeLabel) };
});

const rowRenders = (): number => vi.mocked(timeLabel).mock.calls.length;

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

function rows(count: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = i % 2 === 0;
    out.push({
      id: `m-${i}`,
      conversationId: "conv-1",
      role: user ? "user" : "assistant",
      content: user ? `질문 ${i}` : `답변 ${i}`,
      createdAt: "2026-11-15T01:00:00.000Z",
      response: user ? null : { kind: "text", runtime: "claude", summary: "완료", text: `답변 ${i}` },
    } as unknown as StoredMessage);
  }
  return out;
}

function seed(messageCount: number): void {
  replaceState({
    avatars: [],
    chatPanes: [
      {
        id: "pane-1",
        avatar,
        conversationId: "conv-1",
        messages: rows(messageCount),
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
      } as unknown as ChatPane,
    ],
    activePaneId: "pane-1",
    view: "chat",
  });
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(".composer-box textarea")!;
}

function type(field: HTMLTextAreaElement, text: string): void {
  for (let i = 1; i <= text.length; i += 1) fireEvent.change(field, { target: { value: text.slice(0, i) } });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
  toasts.set([]);
  vi.mocked(timeLabel).mockClear();
});

describe("typing does not redraw the transcript", () => {
  it("draws no message row while the composer is typed into, yet the composer follows every key", async () => {
    seed(20);
    const { container } = render(<ChatView />);
    await act(async () => {});
    expect(container.querySelectorAll(".message")).toHaveLength(20);
    const field = composer(container);
    const send = container.querySelector<HTMLButtonElement>(".send-button:not(.steer-send)")!;
    expect(send.disabled).toBe(true);

    const before = rowRenders();
    expect(before).toBeGreaterThanOrEqual(20);
    type(field, "안녕하세요 반가워요");
    expect(rowRenders()).toBe(before);

    // The composer itself kept up: the value, the store's draft, the send button.
    expect(field.value).toBe("안녕하세요 반가워요");
    expect(readState().chatPanes[0].draft).toBe("안녕하세요 반가워요");
    expect(send.disabled).toBe(false);
  });

  it("still redraws the composer from a store write elsewhere (a send clearing the draft)", async () => {
    seed(4);
    const { container } = render(<ChatView />);
    const field = composer(container);
    type(field, "보낼 말");
    await act(async () =>
      updateState((s) => {
        s.chatPanes[0].draft = "";
      }),
    );
    expect(field.value).toBe("");
  });

  it("narrows the slash menu as the command is typed, with the active option among the shown ones", async () => {
    seed(4);
    const { container } = render(<ChatView />);
    const field = composer(container);
    fireEvent.change(field, { target: { value: "/" } });
    await act(async () => {});
    const all = container.querySelectorAll(".slash-option").length;
    expect(all).toBeGreaterThan(1);
    const before = rowRenders();
    type(field, "/compac");
    expect(rowRenders()).toBe(before);
    const shown = Array.from(container.querySelectorAll(".slash-option"));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(all);
    expect(shown.every((option) => option.textContent?.includes("/compac"))).toBe(true);
    const active = field.getAttribute("aria-activedescendant");
    expect(active && container.querySelector(`#${active}`)).toBeTruthy();
  });

  it("draws no other row while the 여기서부터 다시 editor is typed into", async () => {
    seed(6);
    const { container } = render(<ChatView />);
    const edit = container.querySelectorAll<HTMLButtonElement>('.msg-actions button[aria-label="편집"]')[0];
    fireEvent.click(edit);
    await act(async () => {});
    const editor = container.querySelector<HTMLTextAreaElement>("textarea.rewind-editor-input")!;
    const bubble = editor.closest(".bubble") as HTMLElement;
    const sendEdit = within(bubble).getByRole("button", { name: "보내기" }) as HTMLButtonElement;

    const before = rowRenders();
    fireEvent.change(editor, { target: { value: "" } });
    expect(sendEdit.disabled).toBe(true);
    type(editor, "고친 질문");
    expect(rowRenders()).toBe(before);
    expect(editor.value).toBe("고친 질문");
    expect(readState().chatPanes[0].rewindEdit?.draft).toBe("고친 질문");
    expect(sendEdit.disabled).toBe(false);
  });
});
