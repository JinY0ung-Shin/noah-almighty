// TeamBrainCard: a fake /api/team-brain/cards/:id stands in for the server, so
// every assertion goes through the card's real load / act path.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TeamBrainCard from "../src/client/src/components/TeamBrainCard.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { TeamBrainCardView, TeamBrainIntake, TeamBrainProposal, TeamPageChangeView } from "../src/shared/teamBrain.js";

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

function intake(over: Partial<TeamBrainIntake> = {}): TeamBrainIntake {
  return {
    type: "howto",
    answers: {
      source_kind: "verified",
      source: "직접 해 봄",
      author: "김팀원",
      authored_at: "2026-11-05",
      scope: "운영 환경",
      validity: "unknown",
      verified: "2026-11-05 직접 접속",
    },
    gaps: ["validity"],
    followups: [],
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

let views: Record<string, TeamBrainCardView> = {};
let posted: string[] = [];
/** PUT /provenance bodies, and what the fake server answers to them. */
let provenancePuts: unknown[] = [];
let provenanceReply: ((body: unknown) => Response) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  views = {};
  posted = [];
  provenancePuts = [];
  provenanceReply = null;
  replaceState({ user: null });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const prov = /^\/api\/team-brain\/cards\/([^/]+)\/provenance$/.exec(url);
    if (prov) {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body));
      provenancePuts.push(body);
      return provenanceReply ? provenanceReply(body) : json({ error: "없음" }, 404);
    }
    const m =/^\/api\/team-brain\/cards\/([^/]+)(?:\/(submit|withdraw|apply))?$/.exec(url);
    if (!m) return json({ error: "not found" }, 404);
    const id = decodeURIComponent(m[1]);
    const view = views[id];
    if (!view) return json({ error: "없음" }, 404);
    if (m[2]) {
      expect(init?.method).toBe("POST");
      posted.push(`${m[2]}:${id}`);
    }
    return json(view);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(view: TeamBrainCardView) {
  views[view.proposal.id] = view;
  const r = render(TeamBrainCard, { props: { proposalId: view.proposal.id } });
  await screen.findByText(view.proposal.title);
  return r;
}

describe("TeamBrainCard — propose", () => {
  it("shows the type chip, the source, the intake answers, the unknown chip and the gaps line", async () => {
    await mount(cardView({ proposal: proposal({ intake: intake() }), actions: { submit: true, withdraw: true, apply: false, cancel: false } }));

    expect(screen.getByText("방법·해결")).toBeTruthy();
    expect(screen.getByText("원문 보기")).toBeTruthy();
    expect(screen.getByText("점프 호스트 jump01 을 거쳐 deploy01 에 ssh 로 들어간다.").tagName).toBe("PRE");
    expect(screen.getByText("보충 정보")).toBeTruthy();
    expect(screen.getByText("출처")).toBeTruthy();
    expect(screen.getByText("직접 해 봄")).toBeTruthy();
    expect(screen.getByText("직접 확인 여부")).toBeTruthy();
    // The "unknown" answer renders as the 모름 chip, not as the raw value.
    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText("모름").classList.contains("tag")).toBe(true);
    expect(screen.getByText("아직 모르는 정보: 유효 기간")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("아직 공유되지 않았습니다");
    expect(screen.getByRole("button", { name: "관리자에게 제출" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();
  });

  it("submits through the server and re-renders the returned state", async () => {
    await mount(cardView({ proposal: proposal({ intake: intake() }), actions: { submit: true, withdraw: true, apply: false, cancel: false } }));
    views.p1 = cardView({ proposal: proposal({ intake: intake(), status: "pending" }), actions: { submit: false, withdraw: true, apply: false, cancel: false } });

    await fireEvent.click(screen.getByRole("button", { name: "관리자에게 제출" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("관리자의 검토를 기다리고 있습니다"));
    expect(posted).toEqual(["submit:p1"]);
    expect(screen.getByRole("button", { name: "제안 철회" })).toBeTruthy();
  });

  it("states a needs_info request with the admin's questions", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: intake(), status: "needs_info", decisionReason: "어느 환경에서 확인했나요?" }),
        actions: { submit: false, withdraw: true, apply: false, cancel: false },
      }),
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("관리자가 보완을 요청했습니다: 어느 환경에서 확인했나요? 아바타에게 답을 알려 주세요.");
    expect(status.classList.contains("tone-warn")).toBe(true);
    expect(screen.getByRole("button", { name: "제안 철회" })).toBeTruthy();
  });

  it("shows follow-up rounds and asks to submit again after an answer", async () => {
    const followups = [{ questions: "누가 결정했나요?", answer: "인프라 주간 회의", askedAt: "2026-11-06T01:00:00Z", answeredAt: "2026-11-06T02:00:00Z" }];
    await mount(cardView({ proposal: proposal({ intake: intake({ followups }) }), actions: { submit: true, withdraw: true, apply: false, cancel: false } }));

    const rounds = screen.getByRole("list", { name: "보완 요청 기록" });
    expect(within(rounds).getByText("보완 요청 1")).toBeTruthy();
    expect(within(rounds).getByText("누가 결정했나요?")).toBeTruthy();
    expect(within(rounds).getByText("인프라 주간 회의")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("답변을 반영했습니다. 다시 제출하세요.");
    expect(screen.getByRole("button", { name: "관리자에게 제출" })).toBeTruthy();
  });

  it("renders a legacy row (no intake) as the old note proposal", async () => {
    await mount(cardView({ proposal: proposal({ path: "wiki/howto/ssh.md", op: "update" }) }));
    expect(screen.getByText("팀 브레인 제안 · 노트 수정")).toBeTruthy();
    expect(screen.getByText("제안 내용 보기")).toBeTruthy();
    expect(screen.queryByText("보충 정보")).toBeNull();
    expect(screen.getByText("wiki/howto/ssh.md")).toBeTruthy();
  });

  it("never renders teammate markdown or HTML", async () => {
    const hostile = '<img src=x onerror="alert(1)"> **굵게** <script>x()</script>';
    const { container } = await mount(
      cardView({ proposal: proposal({ content: hostile, intake: intake({ answers: { source: "<b>회의</b>", scope: "x", validity: "y", verified: "z" } }) }) }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("strong.team-brain-name")).toBeTruthy();
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(screen.getByText("<b>회의</b>")).toBeTruthy();
  });
});

function page(over: Partial<TeamPageChangeView> = {}): TeamPageChangeView {
  return {
    path: "wiki/howto/deploy-ssh.md",
    op: "update",
    title: "배포 서버 접속",
    type: "howto",
    before: "---\ntitle: 배포 서버 접속\n---\n# 배포 서버 접속\n직접 deploy01 에 접속한다.\n끝\n",
    after: "---\ntitle: 배포 서버 접속\n---\n# 배포 서버 접속\n점프 호스트 jump01 을 거쳐 deploy01 에 접속한다.\n끝\n",
    stale: false,
    ...over,
  };
}

describe("TeamBrainCard — review / direct", () => {
  const target = proposal({ status: "pending", intake: intake() });

  function approveView(over: Partial<TeamBrainCardView> = {}): TeamBrainCardView {
    return cardView({
      proposal: proposal({
        id: "r1",
        kind: "review",
        title: "배포 서버 접속 방법",
        summary: "",
        content: "",
        path: target.path,
        targetId: "p1",
        decision: "approve",
        changeset: { changes: [], conflicts: ["기존 페이지는 직접 접속이라고 적혀 있음 — 새 원본은 점프 호스트 경유"] },
      }),
      target,
      pages: [
        page(),
        page({ path: "wiki/systems/jump01.md", op: "create", title: "jump01", type: "system", before: null, after: "---\ntitle: jump01\n---\n점프 호스트\n" }),
      ],
      actions: { submit: false, withdraw: false, apply: true, cancel: true },
      ...over,
    });
  }

  it("summarizes the changeset, opens the conflicts box and lists each page", async () => {
    const { container } = await mount(approveView());

    expect(screen.getByText("팀 브레인 검토 · 승인")).toBeTruthy();
    expect(screen.getByText("원본 1건 · 페이지 2개 (새 페이지 1 · 수정 1)")).toBeTruthy();
    expect(screen.getByText("김팀원님의 제안 — 점프 호스트를 거쳐 접속한다")).toBeTruthy();
    expect(screen.getByText("원본 보기")).toBeTruthy();

    const conflicts = screen.getByRole("note");
    expect(conflicts.closest("details")).toBeNull(); // shown open, never folded away
    expect(within(conflicts).getByText("확인이 필요한 충돌")).toBeTruthy();
    expect(within(conflicts).getByText(/새 원본은 점프 호스트 경유/)).toBeTruthy();

    const rows = within(screen.getByRole("list", { name: "바뀌는 페이지" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("수정")).toBeTruthy();
    expect(within(rows[0]).getByText("방법·해결")).toBeTruthy();
    expect(within(rows[0]).getByText("삭제 1줄")).toBeTruthy();
    expect(within(rows[0]).getByText("wiki/howto/deploy-ssh.md")).toBeTruthy();
    expect(within(rows[1]).getByText("새 페이지")).toBeTruthy();
    expect(within(rows[1]).getByText("시스템")).toBeTruthy();

    // The update's diff: the removed line is a <del>, the new one an <ins>.
    const del = container.querySelector("del.team-brain-diff-line.is-del");
    const ins = container.querySelector("ins.team-brain-diff-line.is-add");
    expect(del?.textContent).toContain("직접 deploy01 에 접속한다.");
    expect(ins?.textContent).toContain("점프 호스트 jump01 을 거쳐 deploy01 에 접속한다.");
    // The create shows its full content.
    expect(within(rows[1]).getByText(/점프 호스트$/, { selector: "pre" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "승인 반영" })).toBeTruthy();
  });

  it("applies the approval", async () => {
    await mount(approveView());
    views.r1 = approveView({
      proposal: { ...approveView().proposal, status: "applied" },
      actions: { submit: false, withdraw: false, apply: false, cancel: false },
    });
    // After apply the server stops sending `before` (the committed page IS `after`).
    views.r1.pages = views.r1.pages.map((p) => ({ ...p, before: null }));
    await fireEvent.click(screen.getByRole("button", { name: "승인 반영" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("승인해서 팀 브레인에 반영했습니다."));
    expect(posted).toEqual(["apply:r1"]);
    expect(screen.queryByText("현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.")).toBeNull();
    expect(document.querySelector("del.team-brain-diff-line")).toBeNull();
    expect(screen.queryByRole("button", { name: "승인 반영" })).toBeNull();
  });

  it("warns on a stale page", async () => {
    await mount(approveView({ stale: true, pages: [page({ stale: true })] }));
    expect(screen.getByText("그 사이 이 페이지가 바뀌었습니다.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("그 사이 팀 브레인이 바뀌었습니다");
  });

  it("renders an ask card with the questions and its button", async () => {
    await mount(
      cardView({
        proposal: proposal({ id: "r2", kind: "review", targetId: "p1", decision: "ask", decisionReason: "어느 환경인가요?\n언제부터인가요?", content: "" }),
        target,
        actions: { submit: false, withdraw: false, apply: true, cancel: true },
      }),
    );
    expect(screen.getByText("팀 브레인 검토 · 보완 요청")).toBeTruthy();
    expect(screen.getByText(/어느 환경인가요\?/).textContent).toBe("어느 환경인가요?\n언제부터인가요?");
    expect(screen.getByRole("button", { name: "보완 요청 보내기" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "바뀌는 페이지" })).toBeNull();
  });

  it("keeps the reject card as before", async () => {
    await mount(
      cardView({
        proposal: proposal({ id: "r3", kind: "review", targetId: "p1", decision: "reject", decisionReason: "이미 있는 내용입니다", content: "" }),
        target,
        actions: { submit: false, withdraw: false, apply: true, cancel: true },
      }),
    );
    expect(screen.getByText("반려 사유: 이미 있는 내용입니다")).toBeTruthy();
    expect(screen.queryByText("원본 보기")).toBeNull();
    expect(screen.getByRole("button", { name: "반려 확정" })).toBeTruthy();
  });

  it("words a server-cancelled review card neutrally", async () => {
    await mount(
      cardView({
        proposal: proposal({ id: "r4", kind: "review", status: "cancelled", targetId: "p1", decision: "reject", decisionReason: "중복", content: "" }),
        target: proposal({ status: "approved" }),
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("취소되었습니다.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("labels a direct maintenance changeset without a source", async () => {
    await mount(
      cardView({
        proposal: proposal({ id: "d1", kind: "direct", path: "", content: "", title: "링크 정리", summary: "", changeset: { changes: [], conflicts: [] } }),
        pages: [page()],
        actions: { submit: false, withdraw: false, apply: true, cancel: true },
      }),
    );
    expect(screen.getByText("페이지 1개 (수정 1)")).toBeTruthy();
    expect(screen.queryByText("원본 보기")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "팀 브레인에 반영" })).toBeTruthy();
  });

  it("shows a direct card's own source", async () => {
    await mount(
      cardView({
        proposal: proposal({ id: "d2", kind: "direct", intake: intake(), changeset: { changes: [], conflicts: [] } }),
        pages: [page({ op: "create", before: null })],
        actions: { submit: false, withdraw: false, apply: true, cancel: true },
      }),
    );
    expect(screen.getByText("원본 1건 · 페이지 1개 (새 페이지 1)")).toBeTruthy();
    expect(screen.getByText("원본 보기")).toBeTruthy();
    expect(screen.getByText("보충 정보")).toBeTruthy();
  });
});

describe("TeamBrainCard — 출처 정보 (provenance)", () => {
  const bare = () => intake({ answers: { scope: "운영 환경", validity: "unknown", verified: "예" }, gaps: ["validity"] });
  const missingAll = { editable: true, issues: ["source_kind", "source", "author", "authored_at"] } as TeamBrainCardView["provenance"];

  it("shows the four provenance rows read-only, a missing one as 미기재", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: intake({ answers: { ...intake().answers, author: "" } }), status: "pending" }),
        provenance: { editable: false, issues: ["author"] },
      }),
    );
    expect(screen.getByText("출처 정보")).toBeTruthy();
    expect(screen.getByText("직접 확인")).toBeTruthy(); // the kind's label, not its id
    expect(screen.queryByText("verified")).toBeNull();
    expect(screen.getByText("2026-11-05")).toBeTruthy();
    expect(screen.getByText("미기재").classList.contains("tag")).toBe(true);
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    expect(screen.queryByRole("form", { name: "출처 정보 입력" })).toBeNull();
  });

  it("opens the editor by itself while provenance is missing, and keeps 제출 disabled until it is saved", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        actions: { submit: true, withdraw: true, apply: false, cancel: false },
        provenance: missingAll,
      }),
    );
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    expect(within(form).getByRole("combobox")).toBeTruthy();
    expect((screen.getByRole("button", { name: "관리자에게 제출" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/출처 정보\(출처 유형·출처·작성자·작성일\)를 채워야 제출할 수 있습니다/)).toBeTruthy();
    // No way out of the editor while something is missing.
    expect(within(form).queryByRole("button", { name: "취소" })).toBeNull();
  });

  it("validates on the card before sending (a link must be a URL; a real date), then PUTs and re-renders", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        actions: { submit: true, withdraw: true, apply: false, cancel: false },
        provenance: missingAll,
      }),
    );
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    await fireEvent.change(within(form).getByRole("combobox"), { target: { value: "link" } });
    const source = within(form).getByRole("textbox", { name: "출처" }) as HTMLInputElement;
    const author = within(form).getByRole("textbox", { name: /작성자/ }) as HTMLInputElement;
    const date = within(form).getByRole("textbox", { name: /작성일/ }) as HTMLInputElement;
    await fireEvent.input(source, { target: { value: "사내 위키" } });
    await fireEvent.input(author, { target: { value: "인프라팀" } });
    await fireEvent.input(date, { target: { value: "2026-02-30" } });
    await fireEvent.submit(form);
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toContain("http:// 또는 https://");
    expect(alert.textContent).toContain("작성일은 YYYY-MM-DD");
    expect(provenancePuts).toEqual([]);

    const filled = intake({
      answers: { ...bare().answers, source_kind: "link", source: "https://wiki.internal/deploy", author: "인프라팀", authored_at: "2026-10" },
    });
    provenanceReply = () =>
      json(
        cardView({
          proposal: proposal({ intake: filled }),
          actions: { submit: true, withdraw: true, apply: false, cancel: false },
          provenance: { editable: true, issues: [] },
        }),
      );
    await fireEvent.input(source, { target: { value: "https://wiki.internal/deploy" } });
    await fireEvent.input(date, { target: { value: "2026-10" } });
    await fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("form", { name: "출처 정보 입력" })).toBeNull());
    expect(provenancePuts).toEqual([{ sourceKind: "link", source: "https://wiki.internal/deploy", author: "인프라팀", authoredAt: "2026-10" }]);
    expect(screen.getByText("웹 링크")).toBeTruthy();
    expect(screen.getByText("https://wiki.internal/deploy")).toBeTruthy();
    expect((screen.getByRole("button", { name: "관리자에게 제출" }) as HTMLButtonElement).disabled).toBe(false);
    // Still a draft: the drafter can reopen the editor (prefilled) and leave it again.
    await fireEvent.click(screen.getByRole("button", { name: "수정" }));
    const again = screen.getByRole("form", { name: "출처 정보 입력" });
    expect((within(again).getByRole("textbox", { name: /작성자/ }) as HTMLInputElement).value).toBe("인프라팀");
    await fireEvent.click(within(again).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("form", { name: "출처 정보 입력" })).toBeNull();
  });

  it("shows the server's refusal inside the editor", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        actions: { submit: true, withdraw: true, apply: false, cancel: false },
        provenance: missingAll,
      }),
    );
    provenanceReply = () => json({ error: "출처 정보에 비밀 값(토큰·비밀번호 등)이 들어 있습니다." }, 400);
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    await fireEvent.change(within(form).getByRole("combobox"), { target: { value: "document" } });
    await fireEvent.input(within(form).getByRole("textbox", { name: "출처" }), { target: { value: "배포 가이드" } });
    await fireEvent.input(within(form).getByRole("textbox", { name: /작성자/ }), { target: { value: "모름" } });
    await fireEvent.input(within(form).getByRole("textbox", { name: /작성일/ }), { target: { value: "모름" } });
    await fireEvent.submit(form);
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain("비밀 값"));
  });
});

describe("TeamBrainCard — linked personal notes", () => {
  const HINT = /팀 위키가 정본이 됩니다 — 내 노트는 바뀌지 않으며, 링크로 바꿀지는 아바타가 물어봅니다\./;

  it("shows the submitter's linked 내 브레인 notes read-only on a propose card", async () => {
    const { container } = await mount(
      cardView({
        proposal: proposal({
          intake: intake(),
          personalNotes: [
            { path: "wiki/howto/ssh.md", blob: "a".repeat(40) },
            { path: "raw/2026/11/jump.md", blob: "b".repeat(40) },
          ],
        }),
        actions: { submit: true, withdraw: true, apply: false, cancel: false },
      }),
    );
    const line = container.querySelector(".team-brain-linked-line");
    expect(line?.textContent?.replace(/\s+/g, " ").trim()).toBe("연결된 내 브레인 노트: wiki/howto/ssh.md, raw/2026/11/jump.md");
    expect(screen.getByText(HINT).textContent).toMatch(/^\s*승인되면/);
    expect(container.querySelector(".team-brain-linked-notes button, .team-brain-linked-notes a")).toBeNull();
  });

  it("words the hint for a direct card's own source, and shows nothing without links", async () => {
    await mount(
      cardView({
        proposal: proposal({
          id: "d3",
          kind: "direct",
          intake: intake(),
          changeset: { changes: [], conflicts: [] },
          personalNotes: [{ path: "wiki/howto/ssh.md", blob: "c".repeat(40) }],
        }),
        pages: [page({ op: "create", before: null })],
        actions: { submit: false, withdraw: false, apply: true, cancel: true },
      }),
    );
    expect(screen.getByText(HINT).textContent).toMatch(/^\s*반영되면/);

    await mount(cardView({ proposal: proposal({ id: "p9", title: "링크 없는 제안", intake: intake() }) }));
    expect(screen.getAllByText(/연결된 내 브레인 노트/)).toHaveLength(1);
  });
});

describe("TeamBrainCard — team policy", () => {
  const BEFORE = "---\ndraft_ttl_days: 7\n---\n# 팀 정책\n결정 페이지는 회의록을 원본으로 한다.\n";
  const AFTER = "---\ndraft_ttl_days: 14\n---\n# 팀 정책\n결정 페이지는 회의록을 원본으로 한다.\n";

  function policyView(over: Partial<TeamBrainCardView> = {}): TeamBrainCardView {
    return cardView({
      proposal: proposal({
        id: "pol1",
        kind: "policy",
        path: "POLICY.md",
        op: "update",
        title: "초안 만료를 14일로",
        summary: "검토가 밀려 초안이 자주 만료된다",
        content: AFTER,
        baseBlob: "d".repeat(40),
      }),
      pages: [{ path: "POLICY.md", op: "update", title: "팀 정책", type: null, before: BEFORE, after: AFTER, stale: false }],
      actions: { submit: false, withdraw: false, apply: true, cancel: true },
      ...over,
    });
  }

  it("renders the POLICY.md diff unfolded with 팀 정책 반영, and applies it", async () => {
    const { container } = await mount(policyView());

    expect(screen.getByRole("region", { name: "팀 정책 변경" })).toBeTruthy();
    expect(screen.getByText("팀 정책 변경")).toBeTruthy();
    expect(screen.getByText("검토가 밀려 초안이 자주 만료된다")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "바뀌는 정책 파일" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("수정")).toBeTruthy();
    expect(within(rows[0]).getByText("삭제 1줄")).toBeTruthy();
    expect(within(rows[0]).getByText("POLICY.md")).toBeTruthy();
    expect(rows[0].querySelector("details")?.open).toBe(true);
    expect(container.querySelector("del.team-brain-diff-line.is-del")?.textContent).toContain("draft_ttl_days: 7");
    expect(container.querySelector("ins.team-brain-diff-line.is-add")?.textContent).toContain("draft_ttl_days: 14");
    // Text only: the policy body's heading is not rendered as markdown.
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("버튼을 눌러야 팀 정책이 저장됩니다.");
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();

    views.pol1 = policyView({
      proposal: { ...policyView().proposal, status: "applied" },
      pages: [{ path: "POLICY.md", op: "update", title: "팀 정책", type: null, before: null, after: AFTER, stale: false }],
      actions: { submit: false, withdraw: false, apply: false, cancel: false },
    });
    await fireEvent.click(screen.getByRole("button", { name: "팀 정책 반영" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("팀 정책을 저장했습니다."));
    expect(posted).toEqual(["apply:pol1"]);
    expect(screen.queryByRole("button", { name: "팀 정책 반영" })).toBeNull();
    expect(screen.queryByText("현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.")).toBeNull();
  });

  it("cancels a policy draft through withdraw", async () => {
    await mount(policyView());
    views.pol1 = policyView({
      proposal: { ...policyView().proposal, status: "cancelled" },
      actions: { submit: false, withdraw: false, apply: false, cancel: false },
    });
    await fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("취소했습니다."));
    expect(posted).toEqual(["withdraw:pol1"]);
  });

  it("shows a new POLICY.md in full and warns when it went stale", async () => {
    await mount(
      policyView({
        stale: true,
        actions: { submit: false, withdraw: false, apply: false, cancel: true },
        pages: [{ path: "POLICY.md", op: "create", title: "팀 정책", type: null, before: null, after: AFTER, stale: true }],
      }),
    );
    expect(screen.getByText("새 파일")).toBeTruthy();
    expect(screen.getByText(/draft_ttl_days: 14/, { selector: "pre" })).toBeTruthy();
    expect(screen.getByText("그 사이 팀 정책 파일이 생겼습니다.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("그 사이 팀 정책이 바뀌었습니다");
    expect(screen.queryByRole("button", { name: "팀 정책 반영" })).toBeNull();
  });
});
