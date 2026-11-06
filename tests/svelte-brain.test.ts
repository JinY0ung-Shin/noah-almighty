import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BrainView from "../src/client/src/views/BrainView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { User } from "../src/client/src/lib/types.js";
import type { TeamBrainProposal } from "../src/shared/teamBrain.js";

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
  visibility: "private",
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
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

beforeEach(() => {
  replaceState({ user, view: "brain", settingsTab: "profile" });
});

describe("BrainView empty setup state", () => {
  it("does not request a missing repository and routes the CTA to knowledge settings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(BrainView);

    expect(screen.getByRole("heading", { name: "연결된 지식 저장소가 없습니다" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "새로고침" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "지식 저장소 설정" }));
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("knowledge");
  });
});

describe("BrainView team proposals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function row(over: Partial<TeamBrainProposal>): Omit<TeamBrainProposal, "content"> {
    return {
      id: "p1",
      kind: "propose",
      status: "pending",
      proposerUserId: "owner-1",
      proposerName: "Owner",
      conversationId: "c1",
      path: "raw/2026/11/2026-11-06-p1.md",
      op: "create",
      title: "배포 서버 접속 방법",
      summary: "",
      baseBlob: null,
      intake: { type: "howto", answers: {}, gaps: [], followups: [] },
      changeset: null,
      targetId: null,
      decision: null,
      decisionReason: null,
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      createdAt: "2026-11-06T00:00:00.000Z",
      updatedAt: "2026-11-06T00:00:00.000Z",
      ...over,
    };
  }

  it("labels a needs_info proposal 보완 요청 with the admin's questions and lets it be withdrawn", async () => {
    const mine = [row({ status: "needs_info", decisionReason: "어느 환경에서 확인했나요?" })];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url === "/api/team-brain/graph"
        ? { graph: { nodes: [], edges: [] } }
        : url === "/api/team-brain/proposals/mine"
          ? { proposals: mine }
          : url === "/api/team-brain/status"
            ? { unseenResults: 0, pendingReview: 0 }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    render(BrainView);
    await fireEvent.click(screen.getByRole("tab", { name: /팀 브레인/ }));

    const card = (await screen.findByText("배포 서버 접속 방법")).closest("li") as HTMLElement;
    expect(within(card).getByText("보완 요청").classList.contains("tag")).toBe(true);
    expect(within(card).getByText("관리자의 보완 요청: 어느 환경에서 확인했나요?")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "제안 철회" })).toBeTruthy();
  });
});
