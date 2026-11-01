import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SkillsView from "../src/client/src/views/SkillsView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { User } from "../src/client/src/lib/types.js";

const user = {
  id: "owner-1",
  username: "owner",
  displayName: "Owner",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "group",
  roles: [],
  pluginCount: 0,
  gitTokenSet: false,
  gitIdentityName: null,
  gitIdentityEmail: null,
  knowledgeRepo: null,
  knowledgeBranch: null,
  knowledgeSelected: null,
  modelDefault: null,
  effortDefault: null,
  mcpToolGroupsDefault: null,
  allowedMcpToolGroups: null,
  secretNames: [],
  shellExposedSecretNames: [],
  browserSecrets: [],
  sshPublicKey: null,
  groups: [],
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

const LISTING = {
  id: "share-1",
  ownerUserId: "mate-1",
  skillName: "pptx-report",
  displayName: "Deck maker",
  description: "Weekly report deck generator",
  learnCount: 2,
  contentHash: "hash-v2",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  owner: {
    id: "mate-1",
    username: "mate",
    displayName: "Mate",
    alias: "",
    hasImage: false,
  },
};

/** The viewer's OWN share, mixed into the same feed with a 나 badge. */
const OWN_LISTING = {
  id: "share-own",
  ownerUserId: "owner-1",
  skillName: "my-skill",
  displayName: "my-skill",
  description: "mine",
  learnCount: 3,
  contentHash: "hash-own",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  owner: { id: "owner-1", username: "owner", displayName: "Owner", alias: "", hasImage: false },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mockFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  replaceState({ user, view: "skills", settingsTab: "profile" });
  vi.restoreAllMocks();
});

describe("SkillsView", () => {
  it("lists shared skills with own/learned/update states and my shareable skills", async () => {
    mockFetch({
      "/api/skill-share/available": { skills: [OWN_LISTING, LISTING] },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [
          {
            slug: "my-skill",
            name: "my-skill",
            description: "mine",
            shared: true,
            customDescription: null,
            learnCount: 3,
            origin: null,
          },
          {
            // Learned from LISTING at hash-v1; the share is now at hash-v2 →
            // the card must offer 업데이트 받기 instead of 전수받기.
            slug: "pptx-report",
            name: "pptx-report",
            description: "",
            shared: false,
            customDescription: null,
            learnCount: 0,
            origin: {
              ownerUserId: "mate-1",
              ownerUsername: "mate",
              skillName: "pptx-report",
              contentHash: "hash-v1",
            },
          },
        ],
      },
    });
    render(SkillsView);

    await waitFor(() => {
      expect(screen.getByText("Deck maker")).toBeTruthy();
    });
    expect(screen.getByText("@mate")).toBeTruthy();
    // My own share rides the feed with a 나 badge and NO learn button.
    expect(screen.getByText("나")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "my-skill 스킬 전수받기" })).toBeNull();
    // The stale learned copy gets the update affordance.
    expect(screen.getByText("업데이트 있음")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deck maker 스킬 업데이트 받기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deck maker 스킬 전수받기" })).toBeNull();
    // Adoption badges (전수된 횟수) on the cards and my own row.
    expect(screen.getAllByText("전수 3회").length).toBeGreaterThan(0);
    expect(screen.getByText("전수 2회")).toBeTruthy();
    // Provenance note + unlink affordance in the mine panel (learned rows only).
    expect(screen.getByText("@mate의 pptx-report에서 전수받음")).toBeTruthy();
    expect(screen.getByRole("button", { name: "pptx-report 원본 연결 끊기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "my-skill 원본 연결 끊기" })).toBeNull();
    // My section: the shared toggle reflects server state.
    expect(screen.getByRole("switch", { name: "my-skill 공유" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // A still-linked learned copy can't be re-shared (the server 409s), so the
    // toggle is locked and the row says how to unlock it.
    const learnedToggle = screen.getByRole("switch", {
      name: "pptx-report 공유",
    }) as HTMLButtonElement;
    expect(learnedToggle.disabled).toBe(true);
    expect(learnedToggle.getAttribute("title")).toContain("연결 끊기");
    expect(
      screen.getByText(/전수받은 스킬은 원본과 연결된 동안 공유할 수 없어요/),
    ).toBeTruthy();
    // My own (unlinked) skill stays shareable.
    expect((screen.getByRole("switch", { name: "my-skill 공유" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("previews the whole file manifest, and stays quiet for a one-file skill", async () => {
    // Route order matters: the by-id preview prefix must come BEFORE the feed.
    mockFetch({
      "/api/skill-share/available/share-1": {
        skill: LISTING,
        content: "# pptx-report",
        manifest: {
          files: [
            { path: "SKILL.md", bytes: 1200 },
            { path: "scripts/render.sh", bytes: 40 },
          ],
          totalBytes: 1240,
          truncated: true,
        },
      },
      "/api/skill-share/available": { skills: [LISTING] },
      "/api/skill-share/mine": { repoConfigured: true, skills: [] },
    });
    render(SkillsView);
    await fireEvent.click(await screen.findByRole("button", { name: "미리보기" }));

    expect(await screen.findByText("포함 파일 2개 · 총 1.2 KB")).toBeTruthy();
    expect(screen.getByText("scripts/render.sh")).toBeTruthy();
    expect(screen.getByText(/목록이 잘렸습니다/)).toBeTruthy();
  });

  it("keeps the preview manifest to one line when the skill is only SKILL.md", async () => {
    mockFetch({
      "/api/skill-share/available/share-1": {
        skill: LISTING,
        content: "# pptx-report",
        manifest: {
          files: [{ path: "SKILL.md", bytes: 1200 }],
          totalBytes: 1200,
          truncated: false,
        },
      },
      "/api/skill-share/available": { skills: [LISTING] },
      "/api/skill-share/mine": { repoConfigured: true, skills: [] },
    });
    render(SkillsView);
    await fireEvent.click(await screen.findByRole("button", { name: "미리보기" }));

    expect(await screen.findByText("포함 파일 1개 · 총 1.2 KB")).toBeTruthy();
    expect(screen.queryByText("SKILL.md")).toBeNull(); // no one-item list
    expect(screen.queryByText(/목록이 잘렸습니다/)).toBeNull();
  });

  it("writes and reverts the 소개 문구 of a shared skill", async () => {
    const mineRow = {
      slug: "my-skill",
      name: "my-skill",
      description: "Frontmatter description",
      shared: true,
      customDescription: null as string | null,
      learnCount: 0,
      origin: null,
    };
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const request = init as RequestInit | undefined;
      calls.push({ url, method: request?.method, body: request?.body as string | undefined });
      if (url.includes("/description")) {
        const sent = JSON.parse(String(request?.body)) as { description: string };
        return jsonResponse({
          shared: { ...OWN_LISTING, customDescription: sent.description || null },
        });
      }
      if (url.startsWith("/api/skill-share/mine")) {
        return jsonResponse({ repoConfigured: true, skills: [mineRow] });
      }
      if (url.startsWith("/api/skill-share/available")) return jsonResponse({ skills: [] });
      throw new Error(`unexpected fetch ${url}`);
    });
    render(SkillsView);

    // The frontmatter text is what shows until an introduction is written.
    await screen.findByText("Frontmatter description");
    await fireEvent.click(screen.getByRole("button", { name: "my-skill 소개 수정" }));
    const box = screen.getByRole("textbox", { name: "my-skill 소개 문구" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Frontmatter description"); // pre-filled with what viewers see
    // Nothing to revert to yet.
    expect(screen.queryByRole("button", { name: "frontmatter 설명으로 되돌리기" })).toBeNull();

    await fireEvent.input(box, { target: { value: "주간 보고 덱을 대신 만들어 드려요" } });
    await fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/description"))).toBe(true);
    });
    const put = calls.find((c) => c.url.includes("/description"))!;
    expect(put.url).toBe("/api/skill-share/share/my-skill/description");
    expect(put.method).toBe("PUT");
    expect(JSON.parse(put.body!)).toEqual({ description: "주간 보고 덱을 대신 만들어 드려요" });
    // The row now shows what teammates read, labelled as the introduction.
    expect(await screen.findByText("소개 문구: 주간 보고 덱을 대신 만들어 드려요")).toBeTruthy();

    // With one set, the modal offers the way back to the frontmatter text.
    await fireEvent.click(screen.getByRole("button", { name: "my-skill 소개 수정" }));
    await fireEvent.click(
      await screen.findByRole("button", { name: "frontmatter 설명으로 되돌리기" }),
    );
    await waitFor(() => {
      expect(calls.filter((c) => c.url.includes("/description"))).toHaveLength(2);
    });
    const revert = calls.filter((c) => c.url.includes("/description")).at(-1)!;
    expect(JSON.parse(revert.body!)).toEqual({ description: "" });
    expect(await screen.findByText("Frontmatter description")).toBeTruthy();
  });

  it("guides to knowledge settings when no repo is connected", async () => {
    mockFetch({
      "/api/skill-share/available": { skills: [] },
      "/api/skill-share/mine": { repoConfigured: false, skills: [] },
    });
    render(SkillsView);

    const cta = await screen.findByRole("button", { name: "지식 저장소 연결하기" });
    await fireEvent.click(cta);
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("knowledge");
  });

  // The owner may RENAME a shared skill; the learner's origin marker keeps the
  // name it was learned under, so the join has to fall back to previousNames.
  it("joins a learned copy to a RENAMED share via previousNames", async () => {
    mockFetch({
      "/api/skill-share/available": {
        skills: [
          {
            ...LISTING,
            skillName: "deck-report", // renamed since the copy was learned
            displayName: "Deck maker",
            previousNames: ["pptx-report"],
            contentHash: "hash-v2",
          },
        ],
      },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [
          {
            slug: "pptx-report",
            name: "pptx-report",
            description: "",
            shared: false,
            customDescription: null,
            learnCount: 0,
            origin: {
              ownerUserId: "mate-1",
              ownerUsername: "mate",
              skillName: "pptx-report", // the OLD name
              contentHash: "hash-v1",
            },
          },
        ],
      },
    });
    render(SkillsView);

    expect(await screen.findByText("업데이트 있음")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deck maker 스킬 업데이트 받기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deck maker 스킬 전수받기" })).toBeNull();
  });

  it("shows a renamed share as 전수받음 (no badge) when the hash still matches", async () => {
    mockFetch({
      "/api/skill-share/available": {
        skills: [
          {
            ...LISTING,
            skillName: "deck-report",
            previousNames: ["pptx-report"],
            contentHash: "hash-v1",
          },
        ],
      },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [
          {
            slug: "pptx-report",
            name: "pptx-report",
            description: "",
            shared: false,
            customDescription: null,
            learnCount: 0,
            origin: {
              ownerUserId: "mate-1",
              ownerUsername: "mate",
              skillName: "pptx-report",
              contentHash: "hash-v1", // same content → nothing to update
            },
          },
        ],
      },
    });
    render(SkillsView);

    expect(await screen.findByText("전수받음")).toBeTruthy();
    expect(screen.queryByText("업데이트 있음")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deck maker 스킬 업데이트 받기" })).toBeNull();
    // Already learned, so no 전수받기 either.
    expect(screen.queryByRole("button", { name: "Deck maker 스킬 전수받기" })).toBeNull();
  });

  it("still joins on the CURRENT name when the share also carries previousNames", async () => {
    mockFetch({
      "/api/skill-share/available": {
        skills: [{ ...LISTING, previousNames: ["ancient-name"], contentHash: "hash-v2" }],
      },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [
          {
            slug: "pptx-report",
            name: "pptx-report",
            description: "",
            shared: false,
            customDescription: null,
            learnCount: 0,
            origin: {
              ownerUserId: "mate-1",
              ownerUsername: "mate",
              skillName: "pptx-report", // matches the listing's CURRENT name
              contentHash: "hash-v1",
            },
          },
        ],
      },
    });
    render(SkillsView);

    expect(await screen.findByText("업데이트 있음")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deck maker 스킬 업데이트 받기" })).toBeTruthy();
  });

  // A name a share LEFT is free for another share to take, so two copies can
  // carry markers naming it. Picking either one would light the update badge on
  // a card that may belong to the OTHER share.
  it("lights no badge when the rename trail matches two copies", async () => {
    const copy = (slug: string) => ({
      slug,
      name: slug,
      description: "",
      shared: false,
      customDescription: null,
      learnCount: 0,
      origin: {
        ownerUserId: "mate-1",
        ownerUsername: "mate",
        skillName: "pptx-report", // the name this share left behind
        contentHash: "hash-v1",
      },
    });
    mockFetch({
      "/api/skill-share/available": {
        skills: [
          {
            ...LISTING,
            skillName: "deck-report",
            previousNames: ["pptx-report"],
            contentHash: "hash-v2",
          },
        ],
      },
      "/api/skill-share/mine": {
        repoConfigured: true,
        skills: [copy("pptx-report"), copy("pptx-report-2")],
      },
    });
    render(SkillsView);

    // Unjoined: the card offers a fresh 전수 rather than an update of a guess.
    expect(await screen.findByRole("button", { name: "Deck maker 스킬 전수받기" })).toBeTruthy();
    expect(screen.queryByText("업데이트 있음")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deck maker 스킬 업데이트 받기" })).toBeNull();
  });

  // /mine is the slow path (server-side git fetch) that WRITES fresh hashes, and
  // /available is a fast DB read — so the first paint always shows pre-refresh
  // hashes. The tab re-reads /available once /mine settles, quietly.
  it("re-fetches the available feed after /mine settles, without a spinner flash", async () => {
    const calls: string[] = [];
    let releaseMine: (() => void) | null = null;
    const minePending = new Promise<void>((resolve) => {
      releaseMine = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/skill-share/mine")) {
        await minePending; // the slow reconciliation
        return jsonResponse({ repoConfigured: true, skills: [] });
      }
      if (url.startsWith("/api/skill-share/available")) {
        // Second read sees the refreshed row (renamed + re-hashed by /mine).
        const renamed = calls.filter((c) => c.startsWith("/api/skill-share/available")).length > 1;
        return jsonResponse({
          skills: [renamed ? { ...LISTING, displayName: "Deck maker v2" } : LISTING],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container } = render(SkillsView);

    // First paint: both requests are in flight together, available wins.
    await screen.findByText("Deck maker");
    expect(calls.filter((c) => c.startsWith("/api/skill-share/available"))).toHaveLength(1);
    const gridBefore = container.querySelector(".skill-grid");
    expect(gridBefore).toBeTruthy();

    releaseMine!();
    // The quiet re-read lands and replaces the list…
    expect(await screen.findByText("Deck maker v2")).toBeTruthy();
    expect(calls.filter((c) => c.startsWith("/api/skill-share/available"))).toHaveLength(2);
    expect(calls.indexOf("/api/skill-share/mine")).toBeLessThan(
      calls.lastIndexOf("/api/skill-share/available"),
    );
    // …without ever unmounting the grid, i.e. no 불러오는 중… flash.
    expect(container.querySelector(".skill-grid")).toBe(gridBefore);
    expect(screen.queryByText("불러오는 중…")).toBeNull();
  });

  it("skips the quiet re-fetch when /mine fails", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/skill-share/mine")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "저장소 오류" }),
        } as unknown as Response;
      }
      if (url.startsWith("/api/skill-share/available")) return jsonResponse({ skills: [LISTING] });
      throw new Error(`unexpected fetch ${url}`);
    });
    render(SkillsView);

    expect(await screen.findByText(/내 스킬 목록을 불러오지 못했습니다/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Deck maker")).toBeTruthy();
    });
    expect(calls.filter((c) => c.startsWith("/api/skill-share/available"))).toHaveLength(1);
  });

  it("filters the learnable list by the search query", async () => {
    mockFetch({
      "/api/skill-share/available": {
        skills: [
          LISTING,
          {
            ...LISTING,
            id: "share-2",
            skillName: "code-review",
            displayName: "code-review",
            description: "Review checklists",
          },
        ],
      },
      "/api/skill-share/mine": { repoConfigured: true, skills: [] },
    });
    render(SkillsView);
    await waitFor(() => {
      expect(screen.getByText("code-review")).toBeTruthy();
    });

    const search = screen.getByRole("searchbox", { name: "공유된 스킬 검색" });
    await fireEvent.input(search, { target: { value: "deck" } });
    expect(screen.queryByText("code-review")).toBeNull();
    expect(screen.getByText("Deck maker")).toBeTruthy();
  });
});
