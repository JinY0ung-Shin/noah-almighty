// TeamBrainCard → the avatar: a press of the confirm button (팀 브레인에 반영 /
// 팀 정책 반영) is reported to the chat pane the card sits in (lib/chat.ts
// reportTeamBrainCardPress), done or refused; 취소 is not. (Runs in the vitest
// "react" project.)
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/src/lib/chat", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/chat")>()),
  reportTeamBrainCardPress: vi.fn(async () => {}),
}));

import TeamBrainCard from "../src/client/src/components/TeamBrainCard";
import { reportTeamBrainCardPress } from "../src/client/src/lib/chat";
import { replaceState } from "../src/client/src/lib/state";
import type { TeamBrainCardView, TeamBrainProposal } from "../src/shared/teamBrain";

const reported = vi.mocked(reportTeamBrainCardPress);

function proposal(over: Partial<TeamBrainProposal> = {}): TeamBrainProposal {
  return {
    id: "d1",
    kind: "direct",
    status: "draft",
    proposerUserId: "u1",
    proposerName: "김팀원",
    conversationId: "c1",
    path: "",
    op: "update",
    title: "배포 절차 정리",
    summary: "",
    content: "",
    baseBlob: null,
    intake: null,
    changeset: { changes: [], conflicts: [] },
    personalNotes: [],
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

function cardView(over: Partial<TeamBrainCardView> = {}): TeamBrainCardView {
  return {
    proposal: proposal(),
    stale: false,
    pages: [],
    actions: { apply: false, cancel: false },
    provenance: null,
    legacy: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** What the fake server answers to a GET of the card, and to a press of it. */
let current: TeamBrainCardView;
let pressReply: (() => Response) | null = null;
const pressedUrls: string[] = [];
let paneEl: HTMLElement;

beforeEach(() => {
  reported.mockClear();
  pressReply = null;
  pressedUrls.length = 0;
  replaceState({ user: null });
  paneEl = document.createElement("section");
  paneEl.dataset.pane = "pane-7";
  document.body.appendChild(paneEl);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (/\/(apply|cancel)$/.test(url)) {
      pressedUrls.push(url);
      expect(init?.method).toBe("POST");
      return pressReply ? pressReply() : json(current);
    }
    return /^\/api\/team-brain\/cards\//.test(url) ? json(current) : json({ error: "not found" }, 404);
  });
});

afterEach(() => {
  paneEl.remove();
  vi.restoreAllMocks();
});

async function mount(view: TeamBrainCardView, target: HTMLElement = paneEl) {
  current = view;
  render(<TeamBrainCard proposalId={view.proposal.id} />, { container: target });
  await screen.findByText(view.proposal.title);
}

const DIRECT = () => cardView({ actions: { apply: true, cancel: true } });

describe("TeamBrainCard — telling the avatar about a press", () => {
  it("팀 브레인에 반영: reports the done press to the pane the card sits in", async () => {
    await mount(DIRECT());
    current = cardView({ proposal: { ...DIRECT().proposal, status: "applied" } });
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "d1", "팀 브레인에 반영했습니다: 배포 절차 정리");
    expect(pressedUrls).toEqual(["/api/team-brain/cards/d1/apply"]);
  });

  it("팀 정책 반영: reports the done press of a policy card", async () => {
    const policy = () => cardView({ proposal: proposal({ id: "pol1", kind: "policy", path: "POLICY.md", title: "초안 만료를 14일로" }), actions: { apply: true, cancel: true } });
    await mount(policy());
    current = cardView({ proposal: { ...policy().proposal, status: "applied" } });
    fireEvent.click(screen.getByRole("button", { name: "팀 정책 반영" }));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "pol1", "팀 정책 변경을 반영했습니다: 초안 만료를 14일로");
  });

  it("a press the server refused is reported as failed, and the card still shows why", async () => {
    await mount(DIRECT());
    pressReply = () => json({ error: "그 사이 팀 브레인이 바뀌었습니다." }, 409);
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "d1", "카드의 ‘팀 브레인에 반영’ 버튼을 눌렀지만 처리되지 않았습니다.");
    expect(await screen.findByText("그 사이 팀 브레인이 바뀌었습니다.")).toBeTruthy();
  });

  it("reports nothing the server did not record: a missing card, a lost connection, a cancel", async () => {
    await mount(DIRECT());
    pressReply = () => json({ error: "카드를 찾을 수 없습니다." }, 404);
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await screen.findByText("카드를 찾을 수 없습니다.");
    // The card re-reads itself after a refusal; its buttons come back once that is done.
    const ready = () =>
      waitFor(() => expect((screen.getByRole("button", { name: "팀 브레인에 반영" }) as HTMLButtonElement).disabled).toBe(false));
    await ready();
    pressReply = () => {
      throw new TypeError("Failed to fetch");
    };
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(screen.queryByText("카드를 찾을 수 없습니다.")).toBeNull());
    await ready();
    // 취소 is never reported.
    pressReply = null;
    current = cardView({ proposal: { ...DIRECT().proposal, status: "cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "취소" })).toBeNull());
    expect(pressedUrls.at(-1)).toBe("/api/team-brain/cards/d1/cancel");
    expect(reported).not.toHaveBeenCalled();
  });

  it("reports to the pane it was pressed in even when the card is torn down before the server answers", async () => {
    // A card drafted in the turn still being written lives in the live bubble,
    // which is unmounted when that turn ends — possibly mid-press.
    current = DIRECT();
    const { unmount } = render(<TeamBrainCard proposalId="d1" />, { container: paneEl });
    await screen.findByText("배포 절차 정리");
    let answer!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => (String(input).endsWith("/apply") ? held : json(current)));
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    unmount();
    answer(json(cardView({ proposal: { ...DIRECT().proposal, status: "applied" } })));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "d1", "팀 브레인에 반영했습니다: 배포 절차 정리");
  });

  it("a card outside a chat pane still works, and reports nothing", async () => {
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    try {
      await mount(DIRECT(), loose);
      current = cardView({ proposal: { ...DIRECT().proposal, status: "applied" } });
      fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "팀 브레인에 반영" })).toBeNull());
      expect(reported).not.toHaveBeenCalled();
    } finally {
      loose.remove();
    }
  });
});
