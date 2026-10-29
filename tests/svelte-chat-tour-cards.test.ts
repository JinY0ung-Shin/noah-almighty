// Guided-tour cards in the chat empty state. A first-time owner needs to SEE
// what the avatar can do, so their own pane trades the generic starter chips for
// the shared tour contract's scenarios. Three things are easy to get wrong and
// are pinned here: WHO gets the cards (only the owner's personal avatar —
// `isOwn` is false for colleague panes), that a
// browser tour turns its own prerequisite on in the same click, and that a card
// SEEDS the composer rather than sending (the owner reviews and presses send).
//
// The card only ever carries the literal "/tour <slug>" — the server expands it,
// which is why no prompt text may appear on this side (guarded separately in
// agent-core.test.ts).
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";
import { MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import { TOUR_SCENARIOS } from "../src/shared/tourScenarios.js";

/** Every URL fetch() was asked for during a test, for the "not sent" assertions. */
let fetched: string[] = [];

function avatarOf(over: Partial<AvatarDetail>): AvatarDetail {
  return {
    id: "me",
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
    ...over,
  } as unknown as AvatarDetail;
}

/** An empty pane — the tour cards only exist in the empty state. */
function paneOf(avatar: AvatarDetail, mcpToolGroups?: string[]): ChatPane {
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
    mcpToolGroups,
  } as unknown as ChatPane;
}

function mount(pane: ChatPane, user: Record<string, unknown> = { id: "me" }): void {
  replaceState({
    avatars: [],
    chatPanes: [pane],
    activePaneId: pane.id,
    view: "chat",
    user: user as never,
  });
}

const cardTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".tour-card strong")].map((el) => el.textContent || "");

/** Legacy starter chips — the branch every non-own pane must keep. */
const chipTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".starter-prompt:not(.tour-card)")].map((el) => el.textContent || "");

beforeEach(() => {
  fetched = [];
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
  // No extension in this suite: the bridge probe a browser pane kicks off must
  // resolve without touching what the cards do.
  vi.stubGlobal("chrome", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes("/api/browser-extension")
            ? { version: "0.7.0", minCompatibleVersion: "0.6.0" }
            : { avatars: [], conversations: [], messages: [], skills: [] },
      };
    }),
  );
});

describe("chat empty state — guided tour cards", () => {
  it("gives the owner's own avatar every scenario, in contract order, instead of the chips", async () => {
    mount(paneOf(avatarOf({ isOwn: true })));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelectorAll(".tour-card").length).toBe(TOUR_SCENARIOS.length));
    expect(cardTitles(container)).toEqual(TOUR_SCENARIOS.map((s) => s.titleKo));
    // The description and the duration are the card's other two lines.
    const first = container.querySelector(".tour-card")!;
    expect(first.querySelector("small")?.textContent).toBe(TOUR_SCENARIOS[0].descriptionKo);
    expect(first.querySelector(".tag")?.textContent).toBe(TOUR_SCENARIOS[0].durationKo);
    // The owner's chips are gone — the cards replace them, not join them.
    expect(chipTexts(container)).toEqual([]);
  });

  it("leaves a trusted teammate's avatar on the elevated chips — it is not the owner's own", async () => {
    // isOwn is false, so isOwnPane answers false; a co-member runs elevated
    // there, so the elevated chip branch is the one that must show.
    mount(paneOf(avatarOf({ id: "mate", isOwn: false, elevated: true })));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelector(".starter-prompts")).toBeTruthy());
    expect(container.querySelectorAll(".tour-card").length).toBe(0);
    expect(chipTexts(container)).toContain("내가 지금 맡길 수 있는 일을 3가지로 제안해줘.");
  });

  it("leaves a colleague's avatar on its read-only chips", async () => {
    mount(paneOf(avatarOf({ id: "mate", isOwn: false, elevated: false })));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelector(".starter-prompts")).toBeTruthy());
    expect(container.querySelectorAll(".tour-card").length).toBe(0);
    expect(chipTexts(container)).toContain("이 아바타가 잘 아는 분야를 요약해줘.");
  });

  it("seeds '/tour <slug>' into the composer without sending it", async () => {
    mount(paneOf(avatarOf({ isOwn: true })));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelectorAll(".tour-card").length).toBeGreaterThan(0));
    const capture = [...container.querySelectorAll<HTMLButtonElement>(".tour-card")].find((el) =>
      el.textContent?.includes("업무 지식 기억시키기"),
    )!;
    await fireEvent.click(capture);

    // The literal only — the server owns the expansion.
    expect(readState().chatPanes[0].draft).toBe("/tour capture");
    expect(readState().activePaneId).toBe("pane-1");
    // Reviewed, then sent by the owner: nothing streamed on the click.
    expect(fetched.some((url) => url.includes("/api/chat/stream"))).toBe(false);
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("turns the browser tool group on as the first step of the same click", async () => {
    mount(paneOf(avatarOf({ isOwn: true }), []));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelectorAll(".tour-card").length).toBeGreaterThan(0));
    const browser = [...container.querySelectorAll<HTMLButtonElement>(".tour-card")].find((el) =>
      el.textContent?.includes("브라우저로 일 시키기"),
    )!;
    await fireEvent.click(browser);

    // A card whose prerequisite is left to the user fails on step one.
    expect(readState().chatPanes[0].mcpToolGroups).toContain("browser");
    expect(readState().chatPanes[0].draft).toBe("/tour browser");
  });

  it("surfaces the install guide through the bridge badge when no extension answers", async () => {
    // The card does NOT yank a first-time owner out of chat to the settings tab.
    // Enabling the group in the same click makes the badge appear, and an
    // unreachable bridge renders it as the BUTTON carrying the one-shot
    // browserGuideRequested flag — the user keeps the seeded tour either way.
    mount(paneOf(avatarOf({ isOwn: true }), []));
    const { container } = render(ChatView);

    await waitFor(() => expect(container.querySelectorAll(".tour-card").length).toBeGreaterThan(0));
    const browser = [...container.querySelectorAll<HTMLButtonElement>(".tour-card")].find((el) =>
      el.textContent?.includes("브라우저로 일 시키기"),
    )!;
    await fireEvent.click(browser);

    const badge = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>("button.composer-bridge");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(badge.dataset.status).toBe("unreachable");

    await fireEvent.click(badge);
    expect(readState().browserGuideRequested).toBe(true);
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("access");
    // The tour the owner asked for survived the detour.
    expect(readState().chatPanes[0].draft).toBe("/tour browser");
  });

  it("drops the browser scenario entirely when admin policy blocks the group", async () => {
    const allowed = MCP_TOOL_GROUPS.map((g) => g.id).filter((id) => id !== "browser");
    mount(paneOf(avatarOf({ isOwn: true })), { id: "me", allowedMcpToolGroups: allowed });
    const { container } = render(ChatView);

    // Never offer a route this run cannot have.
    await waitFor(() => expect(container.querySelectorAll(".tour-card").length).toBe(TOUR_SCENARIOS.length - 1));
    expect(cardTitles(container)).not.toContain("브라우저로 일 시키기");
    expect(cardTitles(container)).toContain("업무 지식 기억시키기");
  });
});
