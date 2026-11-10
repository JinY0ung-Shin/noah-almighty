// 관리자 → 팀 브레인 panel: after the schema migration every old note is a raw
// source, so the panel must show the raw / uncompiled counts and point at the
// curate pass — not just a wiki page count of 0.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdminTeamBrainPanel from "../src/client/src/components/AdminTeamBrainPanel.svelte";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { get } from "svelte/store";
import { TEAM_POLICY_DEFAULTS, type TeamPolicyView } from "../src/shared/teamBrain.js";

const backup = { url: "team/brain", branch: "main", adminName: "admin", lastOkAt: null, lastError: null, lastAttemptAt: null };

function policyView(over: Partial<TeamPolicyView> = {}): TeamPolicyView {
  return {
    knobs: { ...TEAM_POLICY_DEFAULTS, reviewMonths: { ...TEAM_POLICY_DEFAULTS.reviewMonths } },
    guidelines: "",
    exists: false,
    problems: [],
    history: [],
    ...over,
  };
}

let policy: TeamPolicyView = policyView();

function policyResponse(url: string): Response | null {
  if (url !== "/api/admin/team-brain/policy") return null;
  return new Response(JSON.stringify({ policy }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function serve(payload: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    policyResponse(String(input)) ??
    new Response(JSON.stringify({ pendingReview: 0, backup, githubHost: "git.example", ...payload }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  policy = policyView();
});

const HINT = "아바타에게 '팀 브레인 정리(team-brain-curate)'를 요청하면 미편찬 원본을 위키로 편찬합니다.";

describe("AdminTeamBrainPanel counts", () => {
  it("shows raw and uncompiled sources with the curate hint, and keeps restore disabled for a non-empty vault", async () => {
    serve({ noteCount: 0, rawSources: 12, uncompiledSources: 12 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("위키 페이지")).toBeTruthy();
    expect(screen.getByText("원본")).toBeTruthy();
    expect(screen.getByText("미편찬 12건")).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect((screen.getByRole("button", { name: "백업에서 복원" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the hint once everything is compiled", async () => {
    serve({ noteCount: 8, rawSources: 5, uncompiledSources: 0 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("미편찬 0건")).toBeTruthy();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("enables restore only for an empty vault", async () => {
    serve({ noteCount: 0, rawSources: 0, uncompiledSources: 0 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("미편찬 0건")).toBeTruthy();
    expect((screen.getByRole("button", { name: "백업에서 복원" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports the migrated counts after a restore (the restore reply has no raw counts)", async () => {
    let restored = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const pol = policyResponse(url);
      if (pol) return pol;
      if (url === "/api/admin/team-brain/backup/restore") {
        expect(init?.method).toBe("POST");
        restored = true;
        return new Response(JSON.stringify({ backup, noteCount: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const counts = restored ? { noteCount: 0, rawSources: 7, uncompiledSources: 7 } : { noteCount: 0, rawSources: 0, uncompiledSources: 0 };
      return new Response(JSON.stringify({ pendingReview: 0, backup, githubHost: "git.example", ...counts }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(AdminTeamBrainPanel, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "백업에서 복원" }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    resolveConfirmation(true);

    expect(await screen.findByText("복원했습니다. 위키 페이지 0개 · 원본 7건 (미편찬 7건)")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("미편찬 7건")).toBeTruthy());
    expect(screen.getByText(HINT)).toBeTruthy();
  });
});

describe("AdminTeamBrainPanel 팀 정책", () => {
  const counts = { noteCount: 3, rawSources: 3, uncompiledSources: 0 };

  it("shows the knobs, marks the non-default ones, the guidelines as text, the problems and the history", async () => {
    policy = policyView({
      exists: true,
      knobs: { ...TEAM_POLICY_DEFAULTS, reviewMonths: { ...TEAM_POLICY_DEFAULTS.reviewMonths, system: 3 }, draftTtlDays: 14 },
      guidelines: "<!-- 팀 가이드라인 -->\n# 가이드라인\n결정 페이지는 **회의록**을 원본으로 한다.\n",
      problems: ["max_open_proposals 값 500이 범위(5–100)를 벗어나 기본값을 씁니다."],
      history: [{ at: "2026-11-09T03:00:00.000Z", by: "관리자", title: "초안 만료를 14일로" }],
    });
    serve(counts);
    const { container } = render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("팀 정책")).toBeTruthy();
    expect(screen.getByText("팀 정책은 관리자 본인의 아바타에게 요청하면 카드로 바뀝니다 (카드의 팀 정책 반영을 눌러야 저장됩니다).")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "팀 정책 설정" });
    const row = (name: string) => within(table).getByRole("rowheader", { name }).closest("tr") as HTMLElement;
    expect(row("시스템 · 다시 확인 주기").textContent).toContain("3개월");
    expect(within(row("시스템 · 다시 확인 주기")).getByText("기본 6개월").classList.contains("tag")).toBe(true);
    expect(row("결정 · 다시 확인 주기").textContent).toContain("12개월");
    expect(row("결정 · 다시 확인 주기").querySelector(".tag")).toBeNull();
    expect(row("초안 만료").textContent).toContain("14일");
    expect(within(row("초안 만료")).getByText("기본 7일")).toBeTruthy();
    expect(row("1인당 열린 카드").textContent).toContain("20개");
    expect(row("1인당 열린 카드").querySelector(".tag")).toBeNull();

    expect(screen.getByText(/범위\(5–100\)를 벗어나/)).toBeTruthy();
    const pre = screen.getByText(/회의록/, { selector: "pre" });
    expect(pre.textContent).toContain("**회의록**");
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.queryByText("작성된 가이드라인이 없습니다.")).toBeNull();
    const history = screen.getByRole("list", { name: "팀 정책 변경 이력" });
    expect(history.textContent).toContain("관리자");
    expect(history.textContent).toContain("초안 만료를 14일로");
    expect(screen.queryByText(/POLICY.md\)이 없어/)).toBeNull();
  });

  it("shows the empty states for a stub-only policy without history", async () => {
    policy = policyView({ exists: true, guidelines: "# Team guidelines\n\n<!-- 여기에\n팀 가이드라인을 적으세요 -->\n" });
    serve(counts);
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("작성된 가이드라인이 없습니다.")).toBeTruthy();
    expect(screen.getByText("변경 이력이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("table", { name: "팀 정책 설정" }).querySelector(".tag")).toBeNull();
  });

  it("says when there is no POLICY.md yet", async () => {
    serve(counts);
    render(AdminTeamBrainPanel, { props: { active: true } });
    expect(await screen.findByText("아직 팀 정책 파일(POLICY.md)이 없어 기본값을 씁니다.")).toBeTruthy();
    expect(screen.getByText("작성된 가이드라인이 없습니다.")).toBeTruthy();
  });

  it("shows a policy load error with a retry, without hiding the rest of the panel", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/admin/team-brain/policy" && fail) {
        return new Response(JSON.stringify({ error: "관리자만 볼 수 있습니다." }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      return (
        policyResponse(url) ??
        new Response(JSON.stringify({ pendingReview: 0, backup, githubHost: "git.example", ...counts }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect((await screen.findByRole("alert")).textContent).toContain("관리자만 볼 수 있습니다.");
    expect(screen.getByText("위키 페이지")).toBeTruthy();
    fail = false;
    await fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(await screen.findByRole("table", { name: "팀 정책 설정" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
