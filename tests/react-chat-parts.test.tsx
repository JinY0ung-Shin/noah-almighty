// React component tests for the chat's cards and prompts — PromptModal,
// ActivityTree and WhatsNewModal (vitest "react" project; see
// tests/react-foundation.test.tsx for the conventions).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityTree from "../src/client/src/components/ActivityTree";
import PromptModal from "../src/client/src/components/PromptModal";
import WhatsNewModal from "../src/client/src/components/WhatsNewModal";
import { openAgentCards } from "../src/client/src/lib/agentCards";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { LiveAgentNode, LiveTaskRow, LiveToolRow } from "../src/client/src/lib/types";

/* ------------------------------------------------------------------ */
/* PromptModal — the avatar's question (the permission card is gone)   */
/* ------------------------------------------------------------------ */

describe("PromptModal", () => {
  it("shows a queued question with no approve/deny controls, and Escape skips it", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    replaceState({
      view: "explore",
      chatPanes: [],
      promptQueue: [
        { id: "q-1", runId: "run-q", paneId: "pane-x", kind: "question", data: { payload: { questions: [{ question: "어느 쪽으로 갈까요?", options: [{ label: "왼쪽" }] }] } } },
      ],
    } as unknown as Parameters<typeof replaceState>[0]);
    render(<PromptModal />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("question");
    expect(within(dialog).getByText("어느 쪽으로 갈까요?")).toBeTruthy();
    const labels = within(dialog).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(labels).not.toContain("승인");
    expect(labels).not.toContain("거부");
    expect(dialog.textContent).not.toContain("권한 요청");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(posted).toEqual([{ runId: "run-q", requestId: "q-1", value: { cancelled: true } }]));
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* ActivityTree — recursive agent → task/tool rendering                */
/* ------------------------------------------------------------------ */

describe("ActivityTree", () => {
  const agents: LiveAgentNode[] = [
    { id: "main", parentId: "", label: "", status: "running", isMain: true },
    { id: "sub1", parentId: "main", label: "조사 담당", status: "running", isMain: false },
  ];
  const tools: LiveToolRow[] = [
    { id: "t1", agentId: "sub1", kind: "tool", label: "명령 실행", detail: "ls -la", status: "done" },
  ];
  const tasks: LiveTaskRow[] = [
    { id: "k1", agentId: "sub1", label: "worker", detail: "진행 상황", status: "running" },
    { id: "k2", agentId: "sub1", label: "", status: "done" },
  ];

  it("renders the recursive agent tree with task/tool rows and Korean a11y labels", () => {
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={tools} tasks={tasks} />);

    expect(container.querySelector(".agent-node.is-main")).toBeTruthy();
    expect(screen.getByText("조사 담당")).toBeTruthy(); // recursive child rendered

    const named = screen.getByText("worker").closest(".task-row")!;
    expect(named.getAttribute("data-status")).toBe("running");
    expect(named.getAttribute("aria-label")).toBe("태스크 · worker · 진행 중 · 진행 상황");
    expect(named.querySelector(".task-detail")!.textContent).toBe("진행 상황");

    const tool = screen.getByText("명령 실행").closest(".tool-row")!;
    expect(tool.getAttribute("data-status")).toBe("done");
    expect(tool.querySelector(".tool-arg")!.textContent).toBe("ls -la");
  });

  it("names every sub-agent card plainly, with no background badge", () => {
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={tools} tasks={tasks} />);

    const card = screen.getByText("조사 담당").closest(".agent-node")!;
    expect(card.getAttribute("aria-label")).toBe("에이전트 · 조사 담당 · 진행 중");
    expect(container.querySelector(".agent-bg-badge")).toBeNull();
    expect(container.textContent).not.toContain("백그라운드");
  });

  it("omits the task-name span for an unnamed task (the 태스크 badge carries it)", () => {
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={tools} tasks={tasks} />);

    const rows = [...container.querySelectorAll(".task-row")];
    expect(rows).toHaveLength(2);
    const unnamed = rows.find((r) => r.getAttribute("aria-label") === "태스크 · 작업 · 완료")!;
    expect(unnamed).toBeTruthy();
    expect(unnamed.querySelector(".task-name")).toBeNull();
  });

  it("lifts kind==='task' tool rows into the owning agent's task list", () => {
    const lifted: LiveToolRow[] = [
      ...tools,
      { id: "bg1", agentId: "main", kind: "task", label: "백그라운드 빌드", status: "running" },
    ];
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={lifted} tasks={[]} />);

    const mainNode = container.querySelector(".agent-node.is-main")!;
    const row = screen.getByText("백그라운드 빌드").closest(".task-row")!;
    expect(mainNode.contains(row)).toBe(true); // rendered as a TASK row, not a tool row
    expect(row.getAttribute("aria-label")).toBe("태스크 · 백그라운드 빌드 · 진행 중");
  });

  it("keeps kind==='memory' rows out of the tree (they render as summary chips instead)", () => {
    const withMemory: LiveToolRow[] = [
      ...tools,
      { id: "m1", agentId: "main", kind: "memory", label: "기억 추가됨", detail: "wiki/people/kim.md", status: "done" },
    ];
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={withMemory} tasks={[]} />);

    // The capture is summary-line UI (ChatView), invisible inside the expanded tree.
    expect(screen.queryByText("기억 추가됨")).toBeNull();
    expect(container.querySelectorAll(".tool-row")).toHaveLength(1);
  });

  it("renders kind==='compact' rows in the tree, announced as 맥락 rather than 도구", () => {
    const withCompact: LiveToolRow[] = [
      ...tools,
      { id: "c1", agentId: "main", kind: "compact", label: "대화 맥락이 요약되었습니다", detail: "자동 요약 · 이전 맥락 약 152K토큰", status: "done" },
      { id: "c2", agentId: "main", kind: "compact", label: "맥락 정리에 실패했습니다", detail: "429 rate limit", status: "failed" },
    ];
    const { container } = render(<ActivityTree agentId="main" agents={agents} tools={withCompact} tasks={[]} />);

    expect(container.querySelectorAll(".tool-row")).toHaveLength(3);
    // A compaction is not a tool call, so it must not be announced as one.
    const ok = screen.getByText("대화 맥락이 요약되었습니다").closest(".tool-row")!;
    expect(ok.getAttribute("aria-label")).toBe(
      "맥락 · 대화 맥락이 요약되었습니다 · 완료 · 자동 요약 · 이전 맥락 약 152K토큰",
    );
    const failed = screen.getByText("맥락 정리에 실패했습니다").closest(".tool-row")!;
    expect(failed.getAttribute("data-status")).toBe("failed");
    expect(failed.querySelector(".tool-arg")!.textContent).toBe("429 rate limit");
  });

  describe("several agents side by side", () => {
    const team: LiveAgentNode[] = [
      { id: "main", parentId: "", label: "", status: "running", isMain: true },
      { id: "a1", parentId: "main", name: "tester", label: "general-purpose · 테스트 실행", status: "running", isMain: false },
      { id: "a2", parentId: "main", label: "Explore · 문서 조사", status: "done", isMain: false },
      { id: "a3", parentId: "main", label: "general-purpose · 막 시작함", status: "running", isMain: false },
    ];
    const teamTools: LiveToolRow[] = [
      { id: "t1", agentId: "a1", kind: "tool", label: "파일 읽기", detail: "package.json", status: "done" },
      { id: "t2", agentId: "a1", kind: "tool", label: "명령 실행", detail: "npm ci", status: "done" },
      { id: "t3", agentId: "a1", kind: "tool", label: "명령 실행", detail: "npm test", status: "running" },
      { id: "t4", agentId: "a2", kind: "tool", label: "검색", detail: "TODO · src", status: "done" },
      { id: "t5", agentId: "main", kind: "tool", label: "파일 쓰기", detail: "notes.md", status: "done" },
    ];
    const teamTasks: LiveTaskRow[] = [
      { id: "k1", agentId: "a1", label: "긴 셸", status: "running" },
    ];
    const card = (text: string) => screen.getByText(text).closest(".agent-node")!;
    const args = (el: Element) =>
      [...el.querySelectorAll(".tool-row .tool-arg")].map((r) => r.textContent);

    beforeEach(() => openAgentCards.set(new Set()));

    it("folds each card to its latest call behind a closed disclosure that counts what it hides", () => {
      render(<ActivityTree agentId="main" agents={team} tools={teamTools} tasks={teamTasks} />);

      const tester = card("@tester");
      const toggle = tester.querySelector("button.agent-toggle")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.querySelector(".agent-count")!.textContent).toBe("도구 3개 · 태스크 1개");
      expect(args(tester)).toEqual(["npm test"]);
      expect(tester.querySelector(".task-row")).toBeNull();
      // A stored (pre-retirement) teammate name leads its accessible name as well as its card.
      expect(tester.getAttribute("aria-label")).toBe("에이전트 · @tester · general-purpose · 테스트 실행 · 진행 중");
      expect(args(card("Explore · 문서 조사"))).toEqual(["TODO · src"]);
      // The main agent's own rows are never folded.
      expect(screen.getByText("notes.md")).toBeTruthy();
      // A just-spawned agent has nothing to fold, so it gets no disclosure.
      expect(card("general-purpose · 막 시작함").querySelector("button")).toBeNull();
    });

    it("opens only the clicked card, and keeps it open when the same ids render afresh", async () => {
      const props = { agentId: "main", agents: team, tools: teamTools, tasks: teamTasks };
      const { unmount } = render(<ActivityTree {...props} />);

      fireEvent.click(screen.getByRole("button", { name: /@tester/ }));
      expect(card("@tester").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);
      expect(card("@tester").querySelector(".task-row")).toBeTruthy();
      expect(card("Explore · 문서 조사").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");

      // A live bubble finalizing into its stored message renders a new tree
      // over the same agent ids: the card the viewer opened stays open.
      unmount();
      render(<ActivityTree {...props} />);
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);

      fireEvent.click(screen.getByRole("button", { name: /@tester/ }));
      expect(args(card("@tester"))).toEqual(["npm test"]);
    });

    it("folds a nested agent's rows but keeps the nested card itself in view", () => {
      const nested: LiveAgentNode[] = [
        team[0],
        { id: "w1", parentId: "main", label: "워크플로 실행: spec", status: "running", isMain: false },
        { id: "w1a", parentId: "w1", label: "general-purpose · 초안", status: "running", isMain: false },
      ];
      const nestedTools: LiveToolRow[] = [
        { id: "n1", agentId: "w1a", kind: "tool", label: "파일 읽기", detail: "spec.md", status: "done" },
        { id: "n2", agentId: "w1a", kind: "tool", label: "파일 쓰기", detail: "draft.md", status: "running" },
      ];
      render(<ActivityTree agentId="main" agents={nested} tools={nestedTools} tasks={[]} />);

      const child = card("general-purpose · 초안");
      expect(card("워크플로 실행: spec").contains(child)).toBe(true);
      expect(child.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      expect(args(child)).toEqual(["draft.md"]);
    });

    it("keeps a lone sub-agent's rows in view with no disclosure", () => {
      render(<ActivityTree agentId="main" agents={[team[0], team[1]]} tools={teamTools} tasks={teamTasks} />);

      const tester = card("@tester");
      expect(tester.querySelector("button")).toBeNull();
      expect(args(tester)).toEqual(["package.json", "npm ci", "npm test"]);
      expect(tester.querySelector(".task-row")).toBeTruthy();
    });

    it("folds as the second agent arrives, and a folded card follows its live rows", async () => {
      // `rerender` takes the whole element, so the props that stay are carried along.
      let props: { agentId: string; agents: LiveAgentNode[]; tools: LiveToolRow[]; tasks: LiveTaskRow[] } = {
        agentId: "main",
        agents: [team[0], team[1]],
        tools: teamTools,
        tasks: [],
      };
      const { rerender } = render(<ActivityTree {...props} />);
      const update = (next: Partial<typeof props>): void => {
        props = { ...props, ...next };
        rerender(<ActivityTree {...props} />);
      };
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);

      update({ agents: [team[0], team[1], team[2]] });
      expect(args(card("@tester"))).toEqual(["npm test"]);

      // A new call replaces the latest row and bumps the count; a status flip
      // on the latest row shows through the fold.
      update({
        tools: [
          ...teamTools.map((t) => (t.id === "t3" ? { ...t, status: "done" as const } : t)),
          { id: "t6", agentId: "a1", kind: "tool", label: "파일 쓰기", detail: "report.md", status: "running" },
        ],
      });
      expect(args(card("@tester"))).toEqual(["report.md"]);
      expect(card("@tester").querySelector(".agent-count")!.textContent).toBe("도구 4개");
      update({
        tools: [
          ...teamTools,
          { id: "t6", agentId: "a1", kind: "tool", label: "파일 쓰기", detail: "report.md", status: "failed" },
        ],
      });
      expect(card("@tester").querySelector(".tool-row")!.getAttribute("data-status")).toBe("failed");
    });

    it("names the disclosure with the run status and the hidden count, never the decorative badge", () => {
      render(<ActivityTree agentId="main" agents={team} tools={teamTools} tasks={teamTasks} />);

      expect(card("@tester").querySelector("button")!.getAttribute("aria-label")).toBe(
        "에이전트 · @tester · general-purpose · 테스트 실행 · 진행 중 · 도구 3개 · 태스크 1개",
      );
    });

    it("folds a tasks-only card to its latest task", () => {
      const shells: LiveTaskRow[] = [
        { id: "s1", agentId: "a2", label: "빌드", status: "done" },
        { id: "s2", agentId: "a2", label: "e2e", detail: "npm run e2e", status: "running" },
      ];
      render(
        <ActivityTree agentId="main" agents={team} tools={teamTools.filter((t) => t.agentId !== "a2")} tasks={shells} />,
      );

      const explore = card("Explore · 문서 조사");
      expect(explore.querySelector(".agent-count")!.textContent).toBe("태스크 2개");
      expect([...explore.querySelectorAll(".task-row .task-name")].map((r) => r.textContent)).toEqual(["e2e"]);
      expect(explore.querySelector(".tool-row")).toBeNull();
    });

    it("renders a snapshot stored before the split (name inside the label) as its label", () => {
      const legacy: LiveAgentNode[] = [
        team[0],
        { id: "old", parentId: "main", label: "@probe · general-purpose · 조사", status: "done", isMain: false },
      ];
      const { container } = render(<ActivityTree agentId="main" agents={legacy} tools={[]} tasks={[]} />);

      expect(screen.getByText("@probe · general-purpose · 조사")).toBeTruthy();
      expect(container.querySelector(".agent-name")).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ */
/* WhatsNewModal — release-note deep links                             */
/* ------------------------------------------------------------------ */

describe("WhatsNewModal", () => {
  it("renders a deep-link button only for actioned items, and clicking it jumps to the guide", async () => {
    render(
      <WhatsNewModal
        releases={[
          {
            id: "2026-08-07",
            items: [
              { title: "브라우저 조작", body: "설명", action: "browser-guide" as const },
              { title: "액션 없는 항목", body: "버튼이 없어야 해요" },
            ],
          },
        ]}
      />,
    );

    // Exactly one deep-link button: the action-less item renders none.
    const buttons = screen.getAllByRole("button", { name: /설치 가이드 열기/ });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);

    // The click routes to 설정 → 권한·연결 and arms the one-shot flag the
    // access tab consumes to open the install guide.
    const state = readState();
    expect(state.view).toBe("settings");
    expect(state.settingsTab).toBe("access");
    expect(state.browserGuideRequested).toBe(true);

    replaceState({ view: "explore", settingsTab: "profile", browserGuideRequested: false });
  });
});
