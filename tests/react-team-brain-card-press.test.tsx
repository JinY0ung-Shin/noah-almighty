// TeamBrainCard → the avatar: a press of 관리자에게 제출 / the confirm button is
// reported to the chat pane the card sits in (lib/chat.ts
// reportTeamBrainCardPress), done or refused; 취소 / 제안 철회 is not. (Runs in the
// vitest "react" project.)
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
    id: "p1",
    kind: "propose",
    status: "draft",
    proposerUserId: "u1",
    proposerName: "김팀원",
    conversationId: "c1",
    path: "raw/2026/11/2026-11-06-p1.md",
    op: "create",
    title: "배포 서버 접속 방법",
    summary: "점프 호스트를 거쳐 접속한다",
    content: "점프 호스트 jump01 을 거쳐 deploy01 에 ssh 로 들어간다.",
    baseBlob: null,
    intake: null,
    changeset: null,
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
    target: null,
    stale: false,
    pages: [],
    actions: { submit: false, withdraw: false, apply: false, cancel: false },
    provenance: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** What the fake server answers to a GET of the card, and to a press of it. */
let current: TeamBrainCardView;
let pressReply: (() => Response) | null = null;
let paneEl: HTMLElement;

beforeEach(() => {
  reported.mockClear();
  pressReply = null;
  replaceState({ user: null });
  paneEl = document.createElement("section");
  paneEl.dataset.pane = "pane-7";
  document.body.appendChild(paneEl);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (/\/(submit|withdraw|apply)$/.test(url)) {
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

const DIRECT = () =>
  cardView({
    proposal: proposal({ id: "d1", kind: "direct", path: "", title: "배포 절차 정리" }),
    actions: { submit: false, withdraw: false, apply: true, cancel: true },
  });

describe("TeamBrainCard — telling the avatar about a press", () => {
  it("관리자에게 제출: reports the done press to the pane the card sits in", async () => {
    await mount(cardView({ actions: { submit: true, withdraw: true, apply: false, cancel: false } }));
    current = cardView({ proposal: proposal({ status: "pending" }), actions: { submit: false, withdraw: true, apply: false, cancel: false } });
    fireEvent.click(screen.getByRole("button", { name: "관리자에게 제출" }));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "p1", "팀 브레인 제안을 관리자에게 제출했습니다: 배포 서버 접속 방법");
  });

  it("팀 브레인에 반영: reports the done press", async () => {
    await mount(DIRECT());
    current = cardView({ proposal: { ...DIRECT().proposal, status: "applied" } });
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    expect(reported).toHaveBeenCalledWith("pane-7", "d1", "팀 브레인에 반영했습니다: 배포 절차 정리");
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
    // 취소 goes through withdraw: never reported.
    pressReply = null;
    current = cardView({ proposal: { ...DIRECT().proposal, status: "cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "취소" })).toBeNull());
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
