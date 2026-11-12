// 관리자 ▸ 도구·스킬 ▸ 공유 스킬 관리 (AdminSharedSkillsPanel) — the system
// admin's team-wide shared-skill block list that replaced the group admins'
// per-group channel blocks when groups were retired.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminSharedSkillsPanel from "../src/client/src/components/AdminSharedSkillsPanel";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm";
import { replaceState } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { SharedSkillBlockEntry, SharedSkillModeration } from "../src/client/src/lib/types";

const SKILL: SharedSkillModeration = {
  id: "share-1",
  ownerUserId: "mate-1",
  skillName: "pptx-report",
  displayName: "Deck maker",
  description: "Weekly report deck generator",
  customDescription: null,
  snapshotDescription: "Weekly report deck generator",
  learnCount: 2,
  contentHash: null,
  previousNames: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  owner: { id: "mate-1", username: "mate", displayName: "Mate", alias: "", hasImage: false },
  blocked: false,
};

const OTHER: SharedSkillModeration = {
  ...SKILL,
  id: "share-2",
  ownerUserId: "mate-2",
  skillName: "sql-helper",
  displayName: "",
  learnCount: 0,
  owner: { id: "mate-2", username: "dba", displayName: "DBA", alias: "", hasImage: false },
};

const SUSPENDED_BLOCK: SharedSkillBlockEntry = {
  ownerUserId: "gone-1",
  ownerUsername: "leaver",
  ownerDisplayName: "Leaver",
  ownerSuspended: true,
  skillName: "secret-scraper",
  blockedAt: "2026-10-01T03:00:00.000Z",
};

const UNSHARED_BLOCK: SharedSkillBlockEntry = {
  ownerUserId: "mate-3",
  ownerUsername: "quiet",
  ownerDisplayName: "Quiet",
  ownerSuspended: false,
  skillName: "old-macro",
  blockedAt: null,
};

type Call = { url: string; method: string; body?: string };

/**
 * Serve the moderation list; a POST/DELETE on mate-1 flips `blocked` for the
 * reload, and a DELETE on an `otherBlocks` entry drops it.
 */
function mockModeration(
  skills: SharedSkillModeration[] = [SKILL],
  others: SharedSkillBlockEntry[] = [],
): { calls: Call[] } {
  const calls: Call[] = [];
  let listing = skills.map((s) => ({ ...s }));
  let otherBlocks = others.map((b) => ({ ...b }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body as string | undefined });
    const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
    if (url.startsWith("/api/admin/shared-skills/blocks")) {
      otherBlocks = otherBlocks.filter((b) => !url.endsWith(`/${b.ownerUserId}/${b.skillName}`));
      listing = listing.map((s) => (s.ownerUserId === "mate-1" ? { ...s, blocked: method === "POST" } : s));
      return ok({ ok: true });
    }
    if (url === "/api/admin/shared-skills") return ok({ skills: listing, otherBlocks });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  return { calls };
}

describe("AdminSharedSkillsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    replaceState({ user: { id: "admin-1", roles: ["admin"] } as never });
  });

  it("does not fetch until its tab is active", async () => {
    const { calls } = mockModeration();
    const view = render(<AdminSharedSkillsPanel active={false} />);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(view.container.textContent).toBe("");
  });

  it("lists every teammate's shares and blocks one team-wide", async () => {
    const { calls } = mockModeration([SKILL, OTHER]);
    const { container } = render(<AdminSharedSkillsPanel active={true} />);

    await screen.findByText("Deck maker");
    expect(container.textContent).toContain("@mate");
    expect(container.textContent).toContain("전수 2회");
    // No display name falls back to the slug.
    expect(screen.getByText("sql-helper")).toBeTruthy();
    expect(screen.queryByText("차단됨")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단" }));
    // Blocking is destructive-shaped, so it goes through the app confirm.
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    expect(get(confirmation)?.message).toContain("모든 팀원");
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(screen.getByText("차단됨")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/admin/shared-skills/blocks");
    expect(JSON.parse(post!.body!)).toEqual({ ownerUserId: "mate-1", skillName: "pptx-report" });
    expect(container.textContent).toContain("차단 1개");
    // The row now offers the inverse action, keyed by the same pair.
    expect(screen.getByRole("button", { name: "Deck maker 차단 해제" })).toBeTruthy();
  });

  it("unblocks through the owner/name path", async () => {
    const { calls } = mockModeration([{ ...SKILL, blocked: true }]);
    render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("차단됨");

    fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단 해제" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    await act(async () => resolveConfirmation(true));
    await waitFor(() => expect(screen.queryByText("차단됨")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/admin/shared-skills/blocks/mate-1/pptx-report");
  });

  it("a cancelled confirm sends nothing", async () => {
    const { calls } = mockModeration();
    render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("Deck maker");
    fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    await act(async () => resolveConfirmation(false));
    await waitFor(() => expect(get(confirmation)).toBeNull());
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("filters by skill or owner and shows the empty state", async () => {
    mockModeration([SKILL, OTHER]);
    const view = render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("Deck maker");
    fireEvent.change(screen.getByRole("searchbox", { name: "공유 스킬 검색" }), { target: { value: "dba" } });
    await waitFor(() => expect(screen.queryByText("Deck maker")).toBeNull());
    expect(screen.getByText("sql-helper")).toBeTruthy();
    view.unmount();

    vi.restoreAllMocks();
    mockModeration([]);
    render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("아직 팀원이 공유한 스킬이 없습니다.");
  });

  it("lists blocks with no live share, counts them, and unblocks one", async () => {
    const { calls } = mockModeration([SKILL], [SUSPENDED_BLOCK, UNSHARED_BLOCK]);
    const { container } = render(<AdminSharedSkillsPanel active={true} />);

    await screen.findByText("secret-scraper");
    expect(screen.getByText("공유 목록에 없는 차단 2개")).toBeTruthy();
    expect(container.textContent).toContain("Leaver · @leaver");
    expect(container.textContent).toContain("차단 시각 기록 없음");
    // Only the suspended owner's row carries the 정지됨 badge.
    expect(screen.getAllByText("정지됨")).toHaveLength(1);
    // Blocks in force = 0 on listed shares + 2 with no share.
    expect(container.textContent).toContain("총 1개 · 차단 2개");

    fireEvent.click(screen.getByRole("button", { name: "secret-scraper (@leaver) 차단 해제" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    expect(get(confirmation)?.message).toContain("다시 공유되면");
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(screen.queryByText("secret-scraper")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/admin/shared-skills/blocks/gone-1/secret-scraper");
    expect(screen.getByText("공유 목록에 없는 차단 1개")).toBeTruthy();
    expect(container.textContent).toContain("총 1개 · 차단 1개");
  });

  it("hides the no-share section when empty, shows it with no shares at all, and searches it", async () => {
    mockModeration([SKILL], []);
    const first = render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("Deck maker");
    expect(screen.queryByText(/공유 목록에 없는 차단/)).toBeNull();
    first.unmount();

    vi.restoreAllMocks();
    mockModeration([], [SUSPENDED_BLOCK, UNSHARED_BLOCK]);
    render(<AdminSharedSkillsPanel active={true} />);
    await screen.findByText("공유 목록에 없는 차단 2개");
    expect(screen.getByText("아직 팀원이 공유한 스킬이 없습니다.")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "공유 스킬 검색" }), { target: { value: "quiet" } });
    await waitFor(() => expect(screen.queryByText("secret-scraper")).toBeNull());
    expect(screen.getByText("old-macro")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "공유 스킬 검색" }), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/"zzz"에 맞는 공유 스킬이 없습니다/)).toBeTruthy());
    expect(screen.queryByText(/공유 목록에 없는 차단/)).toBeNull();
  });
});
