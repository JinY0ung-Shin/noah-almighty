// 탐색의 "시작하기" progress checklist. What is pinned here is the difference
// between this card and the one-off banner it replaced: it DETECTS all four
// items (the old gate looked at 프로필/지식 저장소 only, so an account with no
// credentials and no skills read as fully set up), it removes itself at 4/4
// without storing a dismissal, and the two items an avatar can do FOR the owner
// hand off to a guided tour instead of a settings form.
//
// The skill item is the only one that needs the server, so its failure mode is
// pinned too: a probe that errors leaves the item 필요 rather than ticking it.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExploreView from "../src/client/src/views/ExploreView";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { User } from "../src/client/src/lib/types";

/** Every URL fetch() was asked for — the lazy-probe assertions read this. */
let fetched: string[] = [];
/** What /api/skill-share/mine answers; null makes it reject. */
let mySkills: { repoConfigured: boolean; skills: unknown[] } | null = {
  repoConfigured: false,
  skills: [],
};

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

/** Profile + repo + credentials all done — only 첫 스킬 is left to the probe. */
const THREE_DONE: Partial<User> = {
  alias: "리뷰어",
  knowledgeRepo: "me/brain",
  gitTokenSet: true,
};

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

const banner = (container: HTMLElement) => container.querySelector(".setup-banner");

const progressLabel = (container: HTMLElement) =>
  container.querySelector(".sb-copy strong")?.textContent ?? "";

const steps = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>(".setup-step"),
];

const stepFor = (container: HTMLElement, label: string): HTMLButtonElement =>
  steps(container).find((el) => el.getAttribute("aria-label")?.startsWith(`${label} `))!;

const continueButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".sb-actions .primary")!;

/** Render and let the lazy skill probe settle before asserting on the card. */
async function renderExplore(user: User) {
  replaceState({ user });
  const rendered = render(<ExploreView />);
  await waitFor(() => expect(fetched.some((url) => url.includes("/api/avatars"))).toBe(true));
  await act(async () => {});
  await act(async () => {});
  return rendered;
}

beforeEach(() => {
  fetched = [];
  mySkills = { repoConfigured: false, skills: [] };
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("/api/skill-share/mine")) {
        if (!mySkills) return { ok: false, status: 502, json: async () => ({ error: "저장소 오류" }) } as unknown as Response;
        return ok(mySkills);
      }
      // The detail (trailing slash) backs openSeededChat; the bare list does not.
      if (url.includes("/api/avatars/")) return ok({ avatar: OWN_AVATAR });
      return ok({ avatars: [], conversations: [] });
    }),
  );
  replaceState({
    user: userOf(),
    avatars: [],
    avatarsLoaded: false,
    avatarsLoading: false,
    exploreQuery: "",
    chatPanes: [],
    activePaneId: null,
    conversations: [],
    view: "explore",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExploreView — 시작하기 checklist", () => {
  it("counts all four items, not just 프로필/지식 저장소", async () => {
    const { container } = await renderExplore(userOf());

    expect(banner(container)).not.toBeNull();
    expect(progressLabel(container)).toBe("아바타 시작하기 · 0/4 완료");
    expect(steps(container).map((el) => el.textContent?.trim())).toEqual([
      "프로필",
      "지식 저장소",
      "권한 연결",
      "첫 스킬",
    ]);
    expect(steps(container).every((el) => el.classList.contains("done"))).toBe(false);
  });

  it("still shows the card for an account with a profile and a repo but no credentials", async () => {
    // The defect the checklist fixes: the old gate was `!profileReady ||
    // !knowledgeReady`, so 권한 연결 and 첫 스킬 could never bring it back.
    const { container } = await renderExplore(
      userOf({ alias: "리뷰어", knowledgeRepo: "me/brain" }),
    );

    expect(banner(container)).not.toBeNull();
    expect(progressLabel(container)).toBe("아바타 시작하기 · 2/4 완료");
    expect(stepFor(container, "프로필").classList.contains("done")).toBe(true);
    expect(stepFor(container, "지식 저장소").classList.contains("done")).toBe(true);
    expect(stepFor(container, "권한 연결").getAttribute("aria-label")).toBe("권한 연결 필요");
    expect(stepFor(container, "첫 스킬").getAttribute("aria-label")).toBe("첫 스킬 필요");
  });

  it("counts a stored Confluence PAT as 권한 연결, like the welcome modal does", async () => {
    // The two surfaces disagreed on this before lib/setupReadiness.ts.
    const { container } = await renderExplore(userOf({ secretNames: ["CONFLUENCE_PAT"] }));

    expect(stepFor(container, "권한 연결").classList.contains("done")).toBe(true);
    expect(progressLabel(container)).toBe("아바타 시작하기 · 1/4 완료");
  });

  it("disappears at 4/4 without writing a dismissal", async () => {
    mySkills = { repoConfigured: true, skills: [{ slug: "release" }] };
    const { container } = await renderExplore(userOf(THREE_DONE));

    await waitFor(() =>
      expect(fetched.some((url) => url.includes("/api/skill-share/mine"))).toBe(true),
    );
    await act(async () => {});
    expect(banner(container)).toBeNull();
    // Nothing to bring back next session — the card is done, not dismissed.
    expect(sessionStorage.getItem("setupBannerDismissed")).toBeNull();
  });

  it("never flashes the card at a finished account while the probe is in flight", async () => {
    // The skill answer decides visibility only for an owner whose other three
    // are done, so the card must stay away until it lands — otherwise every
    // 탐색 visit blinks a setup prompt at someone who finished long ago.
    mySkills = { repoConfigured: true, skills: [{ slug: "release" }] };
    replaceState({ user: userOf(THREE_DONE) });
    const { container } = render(<ExploreView />);

    // Synchronous: nothing has been awaited, so the probe cannot have answered.
    expect(banner(container)).toBeNull();
    await waitFor(() =>
      expect(fetched.some((url) => url.includes("/api/skill-share/mine"))).toBe(true),
    );
    await act(async () => {});
    expect(banner(container)).toBeNull();
  });

  it("shows 3/4 for the same account once the probe reports no skills", async () => {
    // Same three items done as above: the ONLY difference is the probe's answer,
    // which proves the skill item is really read from the server.
    mySkills = { repoConfigured: true, skills: [] };
    const { container } = await renderExplore(userOf(THREE_DONE));

    await waitFor(() => expect(banner(container)).not.toBeNull());
    expect(progressLabel(container)).toBe("아바타 시작하기 · 3/4 완료");
    expect(stepFor(container, "첫 스킬").classList.contains("done")).toBe(false);
  });

  it("leaves 첫 스킬 unchecked when the probe fails", async () => {
    // Fail closed: a ticked item on an error would hide setup that is not done.
    mySkills = null;
    const { container } = await renderExplore(userOf(THREE_DONE));

    await waitFor(() => expect(banner(container)).not.toBeNull());
    expect(progressLabel(container)).toBe("아바타 시작하기 · 3/4 완료");
  });

  it("skips the probe entirely for an account with no knowledge repo", async () => {
    // No repo means no own skills, so nobody pays for a request that refreshes
    // the owner's clone server-side.
    const { container } = await renderExplore(userOf({ alias: "리뷰어" }));

    expect(banner(container)).not.toBeNull();
    expect(fetched.some((url) => url.includes("/api/skill-share/mine"))).toBe(false);
    expect(stepFor(container, "첫 스킬").classList.contains("done")).toBe(false);
  });
});

describe("ExploreView — checklist handoffs", () => {
  it("seeds '/tour capture' from 지식 저장소 instead of opening a settings form", async () => {
    const { container } = await renderExplore(userOf({ alias: "리뷰어" }));

    fireEvent.click(stepFor(container, "지식 저장소"));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    // The literal only — the server owns the expansion.
    expect(readState().chatPanes[0].draft).toBe("/tour capture");
    expect(readState().view).toBe("chat");
    // Seeded, never sent.
    expect(fetched.some((url) => url.includes("/api/chat/stream"))).toBe(false);
  });

  it("seeds '/tour skill' from 첫 스킬", async () => {
    mySkills = { repoConfigured: true, skills: [] };
    const { container } = await renderExplore(userOf(THREE_DONE));

    await waitFor(() => expect(banner(container)).not.toBeNull());
    fireEvent.click(stepFor(container, "첫 스킬"));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(readState().chatPanes[0].draft).toBe("/tour skill");
  });

  it("sends 권한 연결 to the settings tab, which needs the owner's hands", async () => {
    const { container } = await renderExplore(userOf({ alias: "리뷰어" }));

    fireEvent.click(stepFor(container, "권한 연결"));

    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("access");
  });

  it("points 이어서 설정 at the first incomplete item", async () => {
    // 프로필 is done, so the primary button must pick up at 지식 저장소.
    const { container } = await renderExplore(userOf({ alias: "리뷰어" }));

    fireEvent.click(continueButton(container));

    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(readState().chatPanes[0].draft).toBe("/tour capture");
  });

  it("keeps the sessionStorage dismissal", async () => {
    const { container } = await renderExplore(userOf());

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".sb-actions .linkish")!,
    );

    expect(banner(container)).toBeNull();
    expect(sessionStorage.getItem("setupBannerDismissed")).toBe("1");
  });
});
