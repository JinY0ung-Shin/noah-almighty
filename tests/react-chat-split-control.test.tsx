// The chat header's 나란히 열기 control. It used to preselect an avatar — the
// current one — so the select read as an AVATAR SWITCHER next to the avatar's
// own name. It now starts on a "나란히 열기…" placeholder: + stays disabled until
// an avatar is picked (a keyboard arrow on a closed select must never open a
// pane by itself), and goes back to the placeholder once the pane is added.
//
// Runs in the vitest "react" project.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { ChatPane } from "../src/client/src/lib/types";
import type { AvatarDetail } from "../src/server/types";

function avatar(id: string, alias: string): AvatarDetail {
  return {
    id,
    username: id,
    displayName: alias,
    alias,
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    isOwn: id === "avatar-1",
    elevated: true,
    plugins: [],
  } as unknown as AvatarDetail;
}

const mine = avatar("avatar-1", "진영");
const mate = avatar("avatar-2", "민지 봇");

function pane(): ChatPane {
  return {
    id: "pane-1",
    avatar: mine,
    conversationId: "conv-1",
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
  } as unknown as ChatPane;
}

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
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith("/api/avatars/avatar-2")
          ? { avatar: mate }
          : { avatars: [], conversations: [], messages: [], skills: [], run: null },
    })),
  );
  replaceState({
    avatars: [mine, mate],
    chatPanes: [pane()],
    activePaneId: "pane-1",
    currentAvatar: mine,
    view: "chat",
  } as unknown as Parameters<typeof replaceState>[0]);
});

describe("나란히 열기 control", () => {
  it("starts on its placeholder, adds only a picked avatar, and resets after adding", async () => {
    render(<ChatView />);
    const select = screen.getByRole("combobox", { name: "나란히 열 아바타" }) as HTMLSelectElement;
    const add = screen.getByRole("button", { name: "나란히 열기" }) as HTMLButtonElement;

    // Nothing preselected — in particular not the avatar this pane already shows.
    expect(select.value).toBe("");
    expect(select.selectedOptions[0].textContent).toBe("나란히 열기…");
    expect(add.disabled).toBe(true);

    fireEvent.change(select, { target: { value: "avatar-2" } });
    expect(select.value).toBe("avatar-2");
    expect(add.disabled).toBe(false);

    fireEvent.click(add);
    await waitFor(() => expect(readState().chatPanes.map((p) => p.avatar.id)).toEqual(["avatar-1", "avatar-2"]));
    await waitFor(() => expect((screen.getAllByRole("combobox", { name: "나란히 열 아바타" })[0] as HTMLSelectElement).value).toBe(""));
  });
});
