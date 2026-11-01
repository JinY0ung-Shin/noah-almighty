// Composer browser-bridge badge. A badge that only STATES a problem is a dead
// end — an unreachable or outdated extension must offer the way out. These
// cover the click contract (badge → 설정 → 권한·연결 + one-shot guide flag) and
// the exact-match case staying an inert span, since a control nobody needs is
// clutter in a hint row that is already dense.
//
// The badge has FOUR rungs (`data-status`): current / compatible / outdated /
// unreachable. `compatible` is the easy one to accidentally re-collapse into
// `current` — it works right now, so it is tempting to call it healthy — which
// is why it gets its own pin on BOTH its distinguishing text and its button.
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";

/** The version the server claims to bundle, per /api/browser-extension. */
const BUNDLED = "0.7.0";

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

/** A pane with the browser tool group on — the badge's render precondition. */
function browserPane(): ChatPane {
  return {
    id: "pane-1",
    avatar,
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
    mcpToolGroups: ["browser"],
  } as unknown as ChatPane;
}

/**
 * Stand in for the extension. `version` null = the probe cannot reach it at all
 * (no extension, wrong origin); a string = an install answering getAllowedOrigins.
 */
function stubExtension(version: string | null): void {
  if (version === null) {
    vi.stubGlobal("chrome", undefined);
    return;
  }
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: (_id: string, _message: unknown, callback: (reply: unknown) => void) => {
        callback({ ok: true, patterns: [], source: "local", version });
      },
    },
  });
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("/api/browser-extension")
          ? { version: BUNDLED, minCompatibleVersion: "0.6.0" }
          : { avatars: [], conversations: [], messages: [], skills: [] },
    })),
  );
  replaceState({
    avatars: [],
    chatPanes: [browserPane()],
    activePaneId: "pane-1",
    view: "chat",
    settingsTab: "profile",
    browserGuideRequested: false,
  });
});

describe("composer browser-bridge badge", () => {
  it("offers a way out when the extension is unreachable, and the click deep-links to the guide", async () => {
    stubExtension(null);
    const { container } = render(ChatView);

    const badge = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>("button.composer-bridge");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(badge.dataset.status).toBe("unreachable");
    expect(badge.textContent).toContain("연결 안 됨");

    await fireEvent.click(badge);

    // The one-shot flag is what the 권한·연결 tab consumes to pop the install
    // guide; without it the user lands on the tab with no idea what to do.
    const state = readState();
    expect(state.view).toBe("settings");
    expect(state.settingsTab).toBe("access");
    expect(state.browserGuideRequested).toBe(true);
  });

  it("offers the same way out for an install below the compatibility floor", async () => {
    stubExtension("0.5.0"); // below minCompatibleVersion 0.6.0
    const { container } = render(ChatView);

    const badge = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>("button.composer-bridge");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(badge.dataset.status).toBe("outdated");
    expect(badge.textContent).toContain("확장 업데이트 필요");

    await fireEvent.click(badge);
    expect(readState().browserGuideRequested).toBe(true);
  });

  it("marks an install above the floor but behind the bundle as its own rung, with an optional way out", async () => {
    stubExtension("0.6.0"); // at minCompatibleVersion, below the bundled 0.7.0

    const { container } = render(ChatView);

    const badge = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>("button.composer-bridge");
      expect(found).toBeTruthy();
      return found!;
    });
    // Not folded into the healthy rung, and not alarmed into the outdated one.
    expect(badge.dataset.status).toBe("compatible");
    expect(badge.textContent).toContain("v0.6.0");
    expect(badge.textContent).toContain("업데이트 있음");
    expect(badge.textContent).not.toContain("업데이트 필요");

    await fireEvent.click(badge);
    expect(readState().browserGuideRequested).toBe(true);
  });

  it("leaves an exact-version install as an inert badge, with no button in the hint row", async () => {
    stubExtension(BUNDLED);
    const { container } = render(ChatView);

    await waitFor(() => {
      const badge = container.querySelector(".composer-bridge");
      expect(badge).toBeTruthy();
      expect(badge!.getAttribute("data-status")).toBe("current");
    });
    expect(container.querySelector("button.composer-bridge")).toBeNull();
    expect(readState().browserGuideRequested).toBe(false);
  });
});
