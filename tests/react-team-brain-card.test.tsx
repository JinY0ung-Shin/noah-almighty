// TeamBrainCard: a fake /api/team-brain/cards/:id stands in for the server, so
// every assertion goes through the card's real load / act path. (Runs in the
// vitest "react" project.)
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TeamBrainCard from "../src/client/src/components/TeamBrainCard";
import { replaceState } from "../src/client/src/lib/state";
import type { TeamBrainCardView, TeamBrainIntake, TeamBrainProposal, TeamPageChangeView } from "../src/shared/teamBrain";

function proposal(over: Partial<TeamBrainProposal> = {}): TeamBrainProposal {
  return {
    id: "d1",
    kind: "direct",
    status: "draft",
    proposerUserId: "u1",
    proposerName: "김팀원",
    conversationId: "c1",
    path: "raw/2026/11/2026-11-06-d1.md",
    op: "create",
    title: "배포 서버 접속 방법",
    summary: "점프 호스트를 거쳐 접속한다",
    content: "점프 호스트 jump01 을 거쳐 deploy01 에 ssh 로 들어간다.",
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
    ...over,
  };
}

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

const DRAFT = { apply: true, cancel: true };
const CLOSED = { apply: false, cancel: false };

/** A teammate's own draft: a new source compiled into one changed page. */
function cardView(over: Partial<TeamBrainCardView> = {}): TeamBrainCardView {
  return {
    proposal: proposal({ intake: intake() }),
    stale: false,
    pages: [page()],
    actions: DRAFT,
    provenance: { editable: true, issues: [] },
    legacy: null,
    ...over,
  };
}

let views: Record<string, TeamBrainCardView> = {};
let posted: string[] = [];
/** Every request the card made, as "METHOD url". */
let requests: string[] = [];
/** PUT /provenance bodies, and what the fake server answers to them. */
let provenancePuts: unknown[] = [];
let provenanceReply: ((body: unknown) => Response) | null = null;
/** Runs when a card is applied — what the commit changes for the other cards. */
let onApply: ((id: string) => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  views = {};
  posted = [];
  requests = [];
  provenancePuts = [];
  provenanceReply = null;
  onApply = null;
  replaceState({ user: null });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const prov = /^\/api\/team-brain\/cards\/([^/]+)\/provenance$/.exec(url);
    if (prov) {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body));
      provenancePuts.push(body);
      return provenanceReply ? provenanceReply(body) : json({ error: "없음" }, 404);
    }
    // The routes that are left: the card itself, apply and cancel.
    const m = /^\/api\/team-brain\/cards\/([^/]+)(?:\/(apply|cancel))?$/.exec(url);
    if (!m) return json({ error: "not found" }, 404);
    const id = decodeURIComponent(m[1]);
    if (!views[id]) return json({ error: "없음" }, 404);
    if (m[2]) {
      expect(init?.method).toBe("POST");
      posted.push(`${m[2]}:${id}`);
      if (m[2] === "apply") onApply?.(id);
    }
    return json(views[id]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(view: TeamBrainCardView) {
  views[view.proposal.id] = view;
  const r = render(<TeamBrainCard proposalId={view.proposal.id} />);
  await screen.findByText(view.proposal.title);
  return r;
}

const ADMIN_WORDING = /관리자|승인|제출|검토|반려|철회/;

describe("TeamBrainCard — a teammate's own changes (direct)", () => {
  it("shows the source, the flagged conflicts, each changed page and the two buttons — to any member", async () => {
    const { container } = await mount(
      cardView({
        proposal: proposal({
          intake: intake(),
          changeset: { changes: [], conflicts: ["기존 페이지는 직접 접속이라고 적혀 있음 — 새 원본은 점프 호스트 경유"] },
        }),
        pages: [
          page(),
          page({ path: "wiki/systems/jump01.md", op: "create", title: "jump01", type: "system", before: null, after: "---\ntitle: jump01\n---\n점프 호스트\n" }),
        ],
      }),
    );

    expect(screen.getByRole("region", { name: "팀 브레인 변경" })).toBeTruthy();
    expect(screen.getByText("팀 브레인 변경")).toBeTruthy();
    expect(screen.getByText("원본 1건 · 페이지 2개 (새 페이지 1 · 수정 1)")).toBeTruthy();
    expect(screen.getByText("점프 호스트를 거쳐 접속한다")).toBeTruthy();

    // The source: provenance out of the fold, the text and the other answers inside it.
    expect(screen.getByText("출처 정보")).toBeTruthy();
    expect(screen.getByText("직접 해 봄")).toBeTruthy();
    const fold = screen.getByText("원본 보기").closest("details") as HTMLElement;
    expect(within(fold).getByText("점프 호스트 jump01 을 거쳐 deploy01 에 ssh 로 들어간다.").tagName).toBe("PRE");
    expect(within(fold).getByText("보충 정보")).toBeTruthy();
    expect(within(fold).getByText("직접 확인 여부")).toBeTruthy();
    // The "unknown" answer renders as the 모름 chip, not as the raw value.
    expect(screen.queryByText("unknown")).toBeNull();
    expect(within(fold).getByText("모름").classList.contains("tag")).toBe(true);
    expect(within(fold).getByText("아직 모르는 정보: 유효 기간")).toBeTruthy();

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
    expect(container.querySelector("del.team-brain-diff-line.is-del")?.textContent).toContain("직접 deploy01 에 접속한다.");
    expect(container.querySelector("ins.team-brain-diff-line.is-add")?.textContent).toContain("점프 호스트 jump01 을 거쳐 deploy01 에 접속한다.");
    // The create shows its full content.
    expect(within(rows[1]).getByText(/점프 호스트$/, { selector: "pre" })).toBeTruthy();

    expect(screen.getByRole("status").textContent).toBe("버튼을 눌러야 팀 브레인에 저장됩니다.");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["수정", "팀 브레인에 반영", "취소"]);
    // Nothing on the card speaks of a reviewer.
    expect(container.textContent).not.toMatch(ADMIN_WORDING);
  });

  it("applies through the server and re-renders the returned state", async () => {
    await mount(cardView());
    views.d1 = cardView({
      proposal: proposal({ intake: intake(), status: "applied" }),
      // After apply the server stops sending `before` (the committed page IS `after`).
      pages: [page({ before: null })],
      actions: CLOSED,
      provenance: { editable: false, issues: [] },
    });
    fireEvent.click(screen.getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("팀 브레인에 저장했습니다."));
    expect(posted).toEqual(["apply:d1"]);
    expect(screen.queryByText("현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.")).toBeNull();
    expect(document.querySelector("del.team-brain-diff-line")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("cancels a draft through the cancel route", async () => {
    await mount(cardView());
    views.d1 = cardView({ proposal: proposal({ intake: intake(), status: "cancelled" }), actions: CLOSED, provenance: { editable: false, issues: [] } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("취소했습니다."));
    expect(posted).toEqual(["cancel:d1"]);
  });

  it("marks a stale page and says why there is no confirm button — without naming an admin", async () => {
    const { container } = await mount(cardView({ stale: true, pages: [page({ stale: true })], actions: { apply: false, cancel: true } }));
    expect(screen.getByText("그 사이 이 페이지가 바뀌었습니다.")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("그 사이 팀 브레인이 바뀌었습니다. 아바타에게 현재 내용에 맞춰 다시 정리해 달라고 요청하세요.");
    expect(status.classList.contains("tone-warn")).toBe(true);
    expect(screen.queryByRole("button", { name: "팀 브레인에 반영" })).toBeNull();
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();
    expect(container.textContent).not.toMatch(ADMIN_WORDING);
  });

  it("never blames a missing admin when the server gives a member's draft no confirm button", async () => {
    const { container } = await mount(cardView({ actions: { apply: false, cancel: true } }));
    expect(screen.getByRole("status").textContent).toBe("지금은 이 계정으로 팀 브레인에 반영할 수 없습니다.");
    expect(screen.queryByRole("button", { name: "팀 브레인에 반영" })).toBeNull();
    expect(container.textContent).not.toMatch(ADMIN_WORDING);
  });

  it("says an unpressed card expired", async () => {
    await mount(cardView({ proposal: proposal({ intake: intake(), status: "expired" }), actions: CLOSED, provenance: { editable: false, issues: [] } }));
    expect(screen.getByRole("status").textContent).toBe("누르지 않아 만료되었습니다.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("labels a changeset that only edits existing pages, without a source", async () => {
    await mount(cardView({ proposal: proposal({ path: "", content: "", title: "링크 정리", summary: "" }), provenance: null }));
    expect(screen.getByText("페이지 1개 (수정 1)")).toBeTruthy();
    expect(screen.queryByText("원본 보기")).toBeNull();
    expect(screen.queryByText("출처 정보")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "팀 브레인에 반영" })).toBeTruthy();
  });

  it("re-reads the other draft cards when one is applied (its commit may have made them stale)", async () => {
    const other = cardView({ proposal: proposal({ id: "d2", title: "같은 페이지를 고치는 다른 초안", intake: intake() }) });
    await mount(other);
    await mount(cardView());
    onApply = () => {
      views.d1 = cardView({ proposal: proposal({ intake: intake(), status: "applied" }), actions: CLOSED, provenance: { editable: false, issues: [] } });
      views.d2 = { ...other, stale: true, pages: [page({ stale: true })], actions: { apply: false, cancel: true } };
    };
    expect(screen.getAllByRole("button", { name: "팀 브레인에 반영" })).toHaveLength(2);
    const card = screen.getByText("배포 서버 접속 방법").closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "팀 브레인에 반영" }));
    await waitFor(() => expect(screen.getByText("그 사이 이 페이지가 바뀌었습니다.")).toBeTruthy());
    expect(posted).toEqual(["apply:d1"]);
    expect(screen.queryByRole("button", { name: "팀 브레인에 반영" })).toBeNull();
  });

  it("never renders teammate markdown or HTML", async () => {
    const hostile = '<img src=x onerror="alert(1)"> **굵게** <script>x()</script>';
    const { container } = await mount(
      cardView({
        proposal: proposal({
          content: hostile,
          intake: intake({ answers: { source: "<b>회의</b>", scope: "x", validity: "y", verified: "z" } }),
          changeset: { changes: [], conflicts: ["<i>충돌</i>"] },
        }),
        pages: [page({ op: "create", before: null, after: "<u>새 페이지</u>" })],
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b, i, u")).toBeNull();
    expect(container.querySelector("strong.team-brain-name")).toBeTruthy();
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(screen.getByText("<b>회의</b>")).toBeTruthy();
    expect(screen.getByText("<i>충돌</i>")).toBeTruthy();
    expect(screen.getByText("<u>새 페이지</u>")).toBeTruthy();
  });
});

describe("TeamBrainCard — a card of the retired review queue (legacy)", () => {
  // The row still carries everything the old card drew; none of it may come back.
  const oldRow = (over: Partial<TeamBrainProposal>) =>
    proposal({
      id: "p1",
      kind: "propose",
      status: "cancelled",
      intake: intake(),
      changeset: null,
      decisionReason: "closed_by_upgrade",
      personalNotes: [{ path: "wiki/howto/ssh.md", blob: "a".repeat(40) }],
      ...over,
    });
  const legacyView = (row: TeamBrainProposal, legacy: NonNullable<TeamBrainCardView["legacy"]>): TeamBrainCardView => ({
    proposal: row,
    stale: false,
    pages: [],
    actions: CLOSED,
    provenance: null,
    legacy,
  });

  it("draws the title and the server's notice, and nothing else, for a submission the upgrade closed", async () => {
    const notice =
      "팀 브레인 작성 방식이 바뀌어 이 제안은 종료되었습니다. 이제 누구나 팀 브레인에 직접 반영할 수 있으니, 아바타에게 이 내용을 팀 브레인에 다시 반영해 달라고 요청하세요.";
    const { container } = await mount(legacyView(oldRow({}), { closedByUpgrade: true, notice, source: null }));

    const card = screen.getByRole("region", { name: "지난 팀 브레인 카드" });
    expect(card.textContent).toBe(`배포 서버 접속 방법${notice}`);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(notice);
    expect(status.classList.contains("tone-info")).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector("details, form, pre, dl")).toBeNull();
    // It only ever read itself.
    expect(requests).toEqual(["GET /api/team-brain/cards/p1"]);
  });

  it("shows the text of a closed submission folded, as plain text, and still no button", async () => {
    const source = "배포는 <b>setup-host.sh</b> 후 **compose up**.\n[링크](https://example.com)";
    const { container } = await mount(legacyView(oldRow({}), { closedByUpgrade: true, notice: "종료되었습니다.", source }));

    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("제출했던 원문 보기");
    // The drafter's text is text: no markup or Markdown is rendered from it.
    expect(details.querySelector("pre")!.textContent).toBe(source);
    expect(details.querySelector("b, strong, a")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form, dl")).toBeNull();
  });

  it("draws a decided row's final state the same way, muted", async () => {
    const row = oldRow({
      id: "r1",
      kind: "review",
      status: "applied",
      decision: "ask",
      decisionReason: "어느 환경인가요?",
      targetId: "p1",
      changeset: { changes: [], conflicts: ["충돌"] },
    });
    const { container } = await mount(legacyView(row, { closedByUpgrade: false, notice: "제안자에게 보완 요청을 보낸 검토 카드입니다.", source: null }));

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("제안자에게 보완 요청을 보낸 검토 카드입니다.");
    expect(status.classList.contains("tone-muted")).toBe(true);
    expect(screen.queryByText(/어느 환경인가요/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("details, form, pre, dl")).toBeNull();
  });
});

describe("TeamBrainCard — 출처 정보 (provenance)", () => {
  const bare = () => intake({ answers: { scope: "운영 환경", validity: "unknown", verified: "예" }, gaps: ["validity"] });
  const missingAll = { editable: true, issues: ["source_kind", "source", "author", "authored_at"] } as TeamBrainCardView["provenance"];

  it("shows the four provenance rows read-only, a missing one as 미기재", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: intake({ answers: { ...intake().answers, author: "" } }), status: "applied" }),
        actions: CLOSED,
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

  it("opens the editor by itself while provenance is missing, and keeps 반영 disabled until it is saved", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        provenance: missingAll,
      }),
    );
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    expect(within(form).getByRole("combobox")).toBeTruthy();
    expect((screen.getByRole("button", { name: "팀 브레인에 반영" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("출처 정보(출처 유형·출처·작성자·작성일)를 채워야 반영할 수 있습니다.")).toBeTruthy();
    // No way out of the editor while something is missing.
    expect(within(form).queryByRole("button", { name: "취소" })).toBeNull();
  });

  it("validates on the card before sending (a link must be a URL; a real date), then PUTs and re-renders", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        provenance: missingAll,
      }),
    );
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "link" } });
    const source = within(form).getByRole("textbox", { name: "출처" }) as HTMLInputElement;
    const author = within(form).getByRole("textbox", { name: /작성자/ }) as HTMLInputElement;
    const date = within(form).getByRole("textbox", { name: /작성일/ }) as HTMLInputElement;
    fireEvent.change(source, { target: { value: "사내 위키" } });
    fireEvent.change(author, { target: { value: "인프라팀" } });
    fireEvent.change(date, { target: { value: "2026-02-30" } });
    fireEvent.submit(form);
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
          provenance: { editable: true, issues: [] },
        }),
      );
    fireEvent.change(source, { target: { value: "https://wiki.internal/deploy" } });
    fireEvent.change(date, { target: { value: "2026-10" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("form", { name: "출처 정보 입력" })).toBeNull());
    expect(provenancePuts).toEqual([{ sourceKind: "link", source: "https://wiki.internal/deploy", author: "인프라팀", authoredAt: "2026-10" }]);
    expect(screen.getByText("웹 링크")).toBeTruthy();
    expect(screen.getByText("https://wiki.internal/deploy")).toBeTruthy();
    expect((screen.getByRole("button", { name: "팀 브레인에 반영" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/채워야 반영할 수 있습니다/)).toBeNull();
    // Still a draft: the drafter can reopen the editor (prefilled) and leave it again.
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    const again = screen.getByRole("form", { name: "출처 정보 입력" });
    expect((within(again).getByRole("textbox", { name: /작성자/ }) as HTMLInputElement).value).toBe("인프라팀");
    fireEvent.click(within(again).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("form", { name: "출처 정보 입력" })).toBeNull();
  });

  it("shows the server's refusal inside the editor", async () => {
    await mount(
      cardView({
        proposal: proposal({ intake: bare() }),
        provenance: missingAll,
      }),
    );
    provenanceReply = () => json({ error: "출처 정보에 비밀 값(토큰·비밀번호 등)이 들어 있습니다." }, 400);
    const form = screen.getByRole("form", { name: "출처 정보 입력" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "document" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "출처" }), { target: { value: "배포 가이드" } });
    fireEvent.change(within(form).getByRole("textbox", { name: /작성자/ }), { target: { value: "모름" } });
    fireEvent.change(within(form).getByRole("textbox", { name: /작성일/ }), { target: { value: "모름" } });
    fireEvent.submit(form);
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain("비밀 값"));
  });
});

describe("TeamBrainCard — linked personal notes", () => {
  it("shows the drafter's linked 내 브레인 notes read-only, and nothing without links", async () => {
    const { container } = await mount(
      cardView({
        proposal: proposal({
          intake: intake(),
          personalNotes: [
            { path: "wiki/howto/ssh.md", blob: "a".repeat(40) },
            { path: "raw/2026/11/jump.md", blob: "b".repeat(40) },
          ],
        }),
      }),
    );
    const line = container.querySelector(".team-brain-linked-line");
    expect(line?.textContent?.replace(/\s+/g, " ").trim()).toBe("연결된 내 브레인 노트: wiki/howto/ssh.md, raw/2026/11/jump.md");
    expect(screen.getByText("반영되면 팀 위키가 정본이 됩니다 — 내 노트는 바뀌지 않으며, 링크로 바꿀지는 아바타가 물어봅니다.")).toBeTruthy();
    expect(container.querySelector(".team-brain-linked-notes button, .team-brain-linked-notes a")).toBeNull();

    await mount(cardView({ proposal: proposal({ id: "d9", title: "링크 없는 변경", intake: intake() }) }));
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
        intake: null,
        changeset: null,
      }),
      pages: [{ path: "POLICY.md", op: "update", title: "팀 정책", type: null, before: BEFORE, after: AFTER, stale: false }],
      provenance: null,
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
      actions: CLOSED,
    });
    fireEvent.click(screen.getByRole("button", { name: "팀 정책 반영" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("팀 정책을 저장했습니다."));
    expect(posted).toEqual(["apply:pol1"]);
    expect(screen.queryByRole("button", { name: "팀 정책 반영" })).toBeNull();
    expect(screen.queryByText("현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.")).toBeNull();
  });

  it("cancels a policy draft through the cancel route", async () => {
    await mount(policyView());
    views.pol1 = policyView({
      proposal: { ...policyView().proposal, status: "cancelled" },
      actions: CLOSED,
    });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("취소했습니다."));
    expect(posted).toEqual(["cancel:pol1"]);
  });

  it("shows a new POLICY.md in full and warns when it went stale", async () => {
    await mount(
      policyView({
        stale: true,
        actions: { apply: false, cancel: true },
        pages: [{ path: "POLICY.md", op: "create", title: "팀 정책", type: null, before: null, after: AFTER, stale: true }],
      }),
    );
    expect(screen.getByText("새 파일")).toBeTruthy();
    expect(screen.getByText(/draft_ttl_days: 14/, { selector: "pre" })).toBeTruthy();
    expect(screen.getByText("그 사이 팀 정책 파일이 생겼습니다.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("그 사이 팀 정책이 바뀌었습니다");
    expect(screen.queryByRole("button", { name: "팀 정책 반영" })).toBeNull();
  });

  it("tells a drafter who is no longer an admin that only an admin applies it", async () => {
    await mount(policyView({ actions: { apply: false, cancel: true } }));
    expect(screen.getByRole("status").textContent).toBe("관리자만 반영할 수 있습니다.");
    expect(screen.queryByRole("button", { name: "팀 정책 반영" })).toBeNull();
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();
  });
});
