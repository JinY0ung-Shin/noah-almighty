// The welcome modal's 체험 시나리오 cards, and the settings path that re-opens the
// modal after the first run. Three things are pinned here: the cards come from
// the SHARED tour contract (never a second hand-kept list), a card seeds
// "/tour <slug>" into a fresh chat with the owner's own avatar rather than
// sending anything, and a browser tour turns its own prerequisite on in the same
// click — while an admin policy that blocks the browser group removes the card
// entirely instead of offering a route the run cannot take.
//
// The re-open path is a one-shot state flag (설정 → 시작 안내 arms it, App drains
// it). The draining end is covered here: a mounted App turns the flag into a
// visible modal and clears it again. (The settings button that sets it is
// SettingsProfileTab's — its case lives with that component's React tests.)
//
// Runs in the vitest "react" project.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../src/client/src/App";
import OnboardingModal from "../src/client/src/components/OnboardingModal";
import { readState, replaceState, updateState } from "../src/client/src/lib/state";
import type { User } from "../src/client/src/lib/types";
import { MCP_TOOL_GROUPS, type McpToolGroupId } from "../src/shared/mcpToolGroups";
import { TOUR_SCENARIOS } from "../src/shared/tourScenarios";

/** Every URL fetch() was asked for, for the "nothing was sent" assertions. */
let fetched: string[] = [];

function userOf(over: Partial<User> = {}): User {
  return {
    id: "me",
    username: "me",
    displayName: "나",
    alias: "",
    bio: "",
    intro: "",
    persona: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    roles: [],
    secretNames: [],
    browserSecrets: [],
    knowledgeRepo: "",
    gitTokenSet: false,
    sshPublicKey: "",
    onboardedAt: "2026-08-01T00:00:00.000Z",
    allowedMcpToolGroups: null,
    mcpToolGroupsDefault: null,
    ...over,
  } as unknown as User;
}

const OWN_AVATAR = {
  id: "me",
  username: "me",
  displayName: "나",
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
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const cardTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".onboard-tour strong")].map((el) => el.textContent || "");

const cardFor = (container: HTMLElement, title: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>(".onboard-tour")].find((el) =>
    el.textContent?.includes(title),
  )!;

beforeEach(() => {
  fetched = [];
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
    vi.fn(async (input: unknown) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("/api/avatars/")) return ok({ avatar: OWN_AVATAR });
      // Exact match: /api/me/notifications and /api/me/knowledge/requests answer
      // with their OWN payloads below, and a prefix match would hand them a user.
      if (url.endsWith("/api/me")) return ok({ user: readState().user });
      if (url.includes("/api/bootstrap")) return ok({ confluenceConfigured: false, githubHost: "github.com" });
      return ok({ conversations: [], avatars: [], notifications: [], requests: [], messages: [], skills: [], plugins: [] });
    }),
  );
  replaceState({
    user: userOf(),
    chatPanes: [],
    activePaneId: null,
    conversations: [],
    view: "explore",
    settingsTab: "profile",
    onboardingRequested: false,
  });
});

afterEach(async () => {
  // Drain the deferred tour handoff (startTour's setTimeout(0) → openSeededChat
  // → its fire-and-forget loadConversations) and any in-flight module loads
  // BEFORE vitest tears the jsdom environment down. A promise that settles
  // after teardown fails the whole run as an unhandled rejection
  // (EnvironmentTeardownError via ChatView's autoscroll import) even with every
  // test green. Drain while the fetch stub is still installed, unstub last.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
});

describe("OnboardingModal — 체험 시나리오 cards", () => {
  it("renders every scenario from the shared contract, in contract order", () => {
    const { container } = render(<OnboardingModal user={userOf()} />);

    expect(container.querySelectorAll(".onboard-tour").length).toBe(TOUR_SCENARIOS.length);
    expect(cardTitles(container)).toEqual(TOUR_SCENARIOS.map((scenario) => scenario.titleKo));
    // Description and duration are the card's other two lines.
    const first = container.querySelector(".onboard-tour")!;
    expect(first.querySelector("small")?.textContent).toBe(TOUR_SCENARIOS[0].descriptionKo);
    expect(first.querySelector(".tag")?.textContent).toBe(TOUR_SCENARIOS[0].durationKo);
  });

  it("closes the modal and seeds '/tour <slug>' into a fresh chat without sending it", async () => {
    const onClose = vi.fn();
    const { container } = render(<OnboardingModal user={userOf()} onClose={onClose} />);

    fireEvent.click(cardFor(container, "업무 지식 기억시키기"));

    // The dialog gets out of the way first (App persists the dismissal).
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    // The literal only — the server owns the expansion.
    expect(readState().chatPanes[0].draft).toBe("/tour capture");
    expect(readState().view).toBe("chat");
    expect(readState().activePaneId).toBe(readState().chatPanes[0].id);
    // Reviewed, then sent by the owner: nothing streamed on the click.
    expect(fetched.some((url) => url.includes("/api/chat/stream"))).toBe(false);
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("turns the browser tool group on for a browser tour, in the picker's canonical order", async () => {
    // A default that already omits 브라우저 조작 — otherwise a fresh pane starts
    // with every group on and the prerequisite step proves nothing.
    const selected: McpToolGroupId[] = ["personal_knowledge", "canvas"];
    replaceState({ user: userOf({ mcpToolGroupsDefault: selected }) });
    const { container } = render(<OnboardingModal user={userOf({ mcpToolGroupsDefault: selected })} />);

    fireEvent.click(cardFor(container, "브라우저로 일 시키기"));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    const pane = readState().chatPanes[0];
    expect(pane.draft).toBe("/tour browser");
    // A card whose prerequisite is left to the user fails on step one.
    expect(pane.mcpToolGroups).toContain("browser");
    // Written in the composer picker's order, not appended at the end.
    expect(pane.mcpToolGroups).toEqual(
      MCP_TOOL_GROUPS.map((group) => group.id).filter(
        (id) => id === "browser" || id === "system" || selected.includes(id),
      ),
    );
  });

  it("drops the browser scenario when admin policy blocks the group", async () => {
    const allowed = MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => id !== "browser");
    const { container } = render(<OnboardingModal user={userOf({ allowedMcpToolGroups: allowed })} />);

    // Never offer a route this run cannot have.
    expect(container.querySelectorAll(".onboard-tour").length).toBe(TOUR_SCENARIOS.length - 1);
    expect(cardTitles(container)).not.toContain("브라우저로 일 시키기");
    expect(cardTitles(container)).toContain("업무 지식 기억시키기");
  });
});

describe("onboarding re-open", () => {
  it("opens the modal from the flag and clears it, even for an onboarded account", async () => {
    const { findByText, container } = render(<App />);

    // Boot completes with an account that has already been onboarded, so the
    // first-run path leaves the modal closed.
    await waitFor(() => expect(readState().booted).toBe(true));
    expect(container.querySelector(".onboard-card")).toBeNull();

    await act(async () => updateState((state) => (state.onboardingRequested = true)));

    expect(await findByText("아바타 사용 준비하기")).toBeTruthy();
    // One-shot: drained on consumption, so it never re-fires on the next update.
    expect(readState().onboardingRequested).toBe(false);
  });
});
