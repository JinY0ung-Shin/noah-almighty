// Svelte component tests — run in the vitest "components" project (jsdom +
// @sveltejs/vite-plugin-svelte + @testing-library/svelte; see vitest.config.ts).
// New component tests must be named tests/svelte-*.test.ts: that glob routes
// them to this project, and to tsconfig.client.json for typechecking.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityTree from "../src/client/src/components/ActivityTree.svelte";
import CanvasPanel from "../src/client/src/components/CanvasPanel.svelte";
import RoutineModal from "../src/client/src/components/RoutineModal.svelte";
import SettingsGroupCard from "../src/client/src/components/SettingsGroupCard.svelte";
import type { SettingsGroup } from "../src/client/src/components/SettingsGroupCard.svelte";
import Toasts from "../src/client/src/components/Toasts.svelte";
import Toggle from "../src/client/src/components/Toggle.svelte";
import WhatsNewModal from "../src/client/src/components/WhatsNewModal.svelte";
import RoutinesView from "../src/client/src/views/RoutinesView.svelte";
import { openAgentCards } from "../src/client/src/lib/agentCards.js";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import type {
  AvatarSummary,
  GroupSharedSkill,
  LiveAgentNode,
  LiveTaskRow,
  LiveToolRow,
  RoutineJob,
  Toast,
} from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* Toggle — accessible switch whose visual state follows the SAVE      */
/* ------------------------------------------------------------------ */

describe("Toggle", () => {
  it("renders an accessible switch and flips only after onChange succeeds", async () => {
    const onChange = vi.fn(async (_next: boolean) => {});
    render(Toggle, { props: { on: false, label: "알림 사용", onChange } });

    const sw = screen.getByRole("switch", { name: "알림 사용" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("on");
  });

  it("keeps the previous visual state when the save rejects", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("save failed");
    });
    render(Toggle, { props: { on: true, label: "저장 실패", onChange } });

    const sw = screen.getByRole("switch", { name: "저장 실패" });
    await fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(false);
    expect(sw.getAttribute("aria-checked")).toBe("true"); // still on
  });

  it("locks while a save is in flight and ignores re-clicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onChange = vi.fn(() => gate);
    render(Toggle, { props: { on: false, label: "느린 저장", onChange } });

    const sw = screen.getByRole("switch", { name: "느린 저장" }) as HTMLButtonElement;
    await fireEvent.click(sw);
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(sw.disabled).toBe(true);

    await fireEvent.click(sw); // busy → ignored
    release();
    await vi.waitFor(() => expect(sw.getAttribute("aria-busy")).toBe("false"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});

/* ------------------------------------------------------------------ */
/* RoutineModal — one-time KST date/time schedule builder              */
/* ------------------------------------------------------------------ */

describe("RoutineModal", () => {
  it("makes content outside the modal inert and restores it on close", () => {
    const background = document.createElement("button");
    background.textContent = "배경 작업";
    document.body.append(background);

    const modal = render(RoutineModal, { props: { routine: null } });
    expect(background.inert).toBe(true);

    modal.unmount();
    expect(background.inert).toBe(false);
    background.remove();
  });

  it("offers a one-time date/time schedule and rejects a past slot", async () => {
    render(RoutineModal, { props: { routine: null } });

    await fireEvent.click(screen.getByRole("radio", { name: "한 번만" }));
    const date = screen.getByLabelText("실행 날짜") as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText("실행 시각")).toBeTruthy();

    await fireEvent.input(screen.getByLabelText("작업 프롬프트"), {
      target: { value: "출시 상태를 확인해줘" },
    });
    expect((screen.getByRole("button", { name: "예약 작업 추가" }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.input(date, { target: { value: "2000-01-01" } });
    expect(screen.getByText("한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "예약 작업 추가" }) as HTMLButtonElement).disabled).toBe(true);
    // The plain-language echo only appears for a schedule that could actually run.
    expect(document.querySelector(".schedule-echo")).toBeNull();
  });

  it("echoes the assembled schedule in plain language and seeds create mode from a preset", async () => {
    render(RoutineModal, {
      props: { routine: null, preset: { name: "주간 회고", prompt: "회고 초안", scheduleKind: "weekly", daysOfWeek: [5], time: "18:00" } },
    });

    expect((screen.getByLabelText("예약 작업 이름") as HTMLInputElement).value).toBe("주간 회고");
    expect((screen.getByLabelText("작업 프롬프트") as HTMLTextAreaElement).value).toBe("회고 초안");
    expect(screen.getByRole("radio", { name: "매주" }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".schedule-echo")?.textContent).toContain("매주 금 18:00 (KST)");

    // Deselecting the only weekday makes the schedule unsavable, so the echo goes.
    await fireEvent.click(screen.getByRole("button", { name: "금" }));
    expect(document.querySelector(".schedule-echo")).toBeNull();
  });

  it("lets a completed one-time routine's metadata be edited without re-running it", async () => {
    const routine: RoutineJob = {
      id: "once-1",
      avatarUserId: "owner-1",
      conversationId: "conv-1",
      name: "지난 작업",
      prompt: "한 번 실행",
      scheduleKind: "once",
      minuteOfDay: 9 * 60,
      time: "09:00",
      daysOfWeek: null,
      intervalMinutes: null,
      runDate: "2000-01-01",
      enabled: false,
      nextRunAt: null,
      lastRunAt: "2000-01-01T00:00:00.000Z",
      lastStatus: "success",
      lastError: null,
      completedAt: "2000-01-01T00:00:00.000Z",
      createdAt: "1999-12-01T00:00:00.000Z",
      personalAgentId: null,
    };
    render(RoutineModal, { props: { routine } });

    expect(screen.queryByRole("button", { name: "지금 실행" })).toBeNull();
    await fireEvent.input(screen.getByLabelText("예약 작업 이름"), {
      target: { value: "지난 작업 이름 변경" },
    });
    expect((screen.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* RoutinesView — always-on lifecycle grouping + status filter chips   */
/* ------------------------------------------------------------------ */

describe("RoutinesView", () => {
  /** An enabled daily routine; every field the view reads is overridable. */
  function routineOf(over: Partial<RoutineJob> = {}): RoutineJob {
    return {
      id: "routine-1",
      avatarUserId: "owner-1",
      conversationId: "conv-1",
      name: "매일 점검",
      prompt: "작업 실행",
      scheduleKind: "daily",
      minuteOfDay: 9 * 60,
      time: "09:00",
      daysOfWeek: null,
      intervalMinutes: null,
      runDate: null,
      enabled: true,
      nextRunAt: "2026-07-14T00:00:00.000Z",
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      completedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      personalAgentId: null,
      ...over,
    };
  }

  /** The shape the server tags onto the owner's own bots in GET /api/avatars. */
  function botOf(agentId: string, displayName: string): AvatarSummary {
    return {
      id: `personal:owner-1:${agentId}`,
      username: `personal-agent-${agentId}`,
      displayName,
      alias: "",
      bio: "",
      hashtags: [],
      hasImage: false,
      pluginCount: 0,
      visibility: "group",
      updatedAt: null,
      runtime: "native",
      personalAgent: { agentId, defaultModel: null },
    };
  }

  /** Answers the view's boot requests; anything unnamed gets an empty list. */
  function stubRoutineFetch(routines: RoutineJob[], avatars: AvatarSummary[]): void {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.startsWith("/api/me/routines")
        ? { routines }
        : path.startsWith("/api/avatars")
          ? { avatars }
          : { conversations: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    replaceState({
      routines: [],
      routineConversations: [],
      routineConversationId: "",
      routineMessages: [],
      routineSearch: "",
      routineTypeFilter: "all",
      routineFilter: "all",
      // The view loads the roster itself, so the chip's name must survive a cold
      // start — seeding it here would hide a missing loadAvatars() call.
      avatars: [],
      avatarsLoaded: false,
      avatarsLoading: false,
    });
  }

  it("groups routines into 예정 / 일시 정지 / collapsed 지난 실행 without a type filter", async () => {
    const base: Omit<RoutineJob, "id" | "conversationId" | "name" | "scheduleKind" | "runDate" | "enabled" | "nextRunAt" | "lastRunAt" | "lastStatus" | "completedAt"> = {
      avatarUserId: "owner-1",
      prompt: "작업 실행",
      minuteOfDay: 9 * 60,
      time: "09:00",
      daysOfWeek: null,
      intervalMinutes: null,
      lastError: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      personalAgentId: null,
    };
    const routines: RoutineJob[] = [
      {
        ...base,
        id: "daily-1",
        conversationId: "conv-daily",
        name: "매일 점검",
        scheduleKind: "daily",
        runDate: null,
        enabled: true,
        nextRunAt: "2026-07-14T00:00:00.000Z",
        lastRunAt: null,
        lastStatus: null,
        completedAt: null,
      },
      {
        ...base,
        id: "once-upcoming",
        conversationId: "conv-once-upcoming",
        name: "출시일 확인",
        scheduleKind: "once",
        runDate: "2026-07-15",
        enabled: true,
        nextRunAt: "2026-07-15T00:00:00.000Z",
        lastRunAt: null,
        lastStatus: null,
        completedAt: null,
      },
      {
        ...base,
        id: "once-completed",
        conversationId: "conv-once-completed",
        name: "백업 확인",
        scheduleKind: "once",
        runDate: "2026-07-10",
        enabled: false,
        nextRunAt: null,
        lastRunAt: "2026-07-10T00:00:00.000Z",
        lastStatus: "success",
        completedAt: "2026-07-10T00:00:00.000Z",
      },
      {
        ...base,
        id: "daily-paused",
        conversationId: "conv-daily-paused",
        name: "야간 정리",
        scheduleKind: "daily",
        runDate: null,
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        completedAt: null,
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.startsWith("/api/me/routines") ? { routines } : { conversations: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    replaceState({
      routines: [],
      routineConversations: [],
      routineConversationId: "",
      routineMessages: [],
      routineSearch: "",
      routineTypeFilter: "all",
      routineFilter: "all",
    });

    render(RoutinesView);

    // Grouping is unconditional: recurring and one-time jobs share 예정, and
    // the completed one folds away into a collapsed 지난 실행 by default.
    await screen.findByText("매일 점검");
    const groupHeads = () =>
      Array.from(document.querySelectorAll(".routine-group-head")).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
    expect(groupHeads()).toEqual(["예정 2", "일시 정지 1", "지난 실행 1"]);
    expect(screen.getByText("출시일 확인")).toBeTruthy();
    expect(screen.getByText("야간 정리")).toBeTruthy();
    expect(screen.getByText("백업 확인")).toBeTruthy();
    const history = document.querySelector("details.routine-group") as HTMLDetailsElement;
    await waitFor(() => expect(history.open).toBe(false));

    // The status chips replace the old two segmented rows; 실패 stays hidden
    // while nothing has failed, and 완료 shows because one job completed.
    expect(screen.queryByRole("radio", { name: /^실패/ })).toBeNull();
    const completedFilter = screen.getByRole("radio", { name: "완료 1" });
    await fireEvent.click(completedFilter);
    expect(readState().routineFilter).toBe("completed");
    await waitFor(() => expect(screen.queryByText("매일 점검")).toBeNull());
    expect(groupHeads()).toEqual(["지난 실행 1"]);
    expect(screen.getByText("백업 확인")).toBeTruthy();
  });

  it("names the owning bot on a 봇 루틴 and leaves the main avatar's own routines bare", async () => {
    stubRoutineFetch(
      [
        routineOf({ id: "bot-routine", conversationId: "conv-bot", name: "봇 아침 브리핑", personalAgentId: "bot-1" }),
        routineOf({ id: "own-routine", conversationId: "conv-own", name: "내 아침 브리핑" }),
      ],
      [botOf("bot-1", "리뷰 봇"), botOf("bot-2", "문서 봇")],
    );

    render(RoutinesView);
    await screen.findByText("봇 아침 브리핑");

    // The roster is fetched by the view itself, so the name lands a tick after
    // the rows do — what matters is where it settles.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".routine-row")].map((row) => [
          row.querySelector(".routine-row-name")?.textContent?.trim(),
          row.querySelector(".routine-row-bot")?.textContent?.trim() ?? null,
        ]),
      ).toEqual([
        ["봇 아침 브리핑", "리뷰 봇"],
        ["내 아침 브리핑", null],
      ]),
    );
    expect(document.querySelector(".routine-row-bot")?.getAttribute("title")).toBe("봇이 대신 실행하는 예약 작업");

    // The chip sits INSIDE the row button, whose aria-label wins over its
    // contents — so the bot has to be spelled into that name or it is never
    // announced at all.
    expect(screen.getByRole("button", { name: "예약 작업 결과 보기: 봇 아침 브리핑 (리뷰 봇)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "예약 작업 결과 보기: 내 아침 브리핑" })).toBeTruthy();
  });

  it("still marks a 봇 루틴 when the roster is unavailable, falling back to a bare 봇", async () => {
    stubRoutineFetch(
      [routineOf({ id: "bot-routine", conversationId: "conv-bot", name: "봇 아침 브리핑", personalAgentId: "bot-1" })],
      [],
    );

    render(RoutinesView);
    await screen.findByText("봇 아침 브리핑");

    // "누가 실행하는가"가 "어느 봇인가"보다 먼저다 — 이름을 못 찾았다고 칩을
    // 통째로 숨기면 사용자는 자기 아바타 루틴으로 오해한다.
    await waitFor(() => expect(document.querySelector(".routine-row-bot")?.textContent?.trim()).toBe("봇"));
    expect(screen.getByRole("button", { name: "예약 작업 결과 보기: 봇 아침 브리핑 (봇)" })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* Toasts — store-driven notification stack                            */
/* ------------------------------------------------------------------ */

describe("Toasts", () => {
  beforeEach(() => {
    toasts.set([]);
  });

  it("renders queued toasts with urgency-aware live-region roles", () => {
    const queue: Toast[] = [
      { id: "t1", message: "저장 완료", kind: "info" },
      { id: "t2", message: "연결 끊김", kind: "warn" },
    ];
    toasts.set(queue);
    render(Toasts);

    const info = screen.getByText("저장 완료").closest(".toast")!;
    const warn = screen.getByText("연결 끊김").closest(".toast")!;
    expect(info.getAttribute("role")).toBe("status");
    expect(info.getAttribute("aria-live")).toBe("polite");
    expect(warn.getAttribute("role")).toBe("alert");
    expect(warn.getAttribute("aria-live")).toBe("assertive");
    expect(warn.className).toContain("warn");
  });

  it("runs a toast action then dismisses it; × closes plain toasts", async () => {
    const action = vi.fn();
    toasts.set([
      { id: "a1", message: "삭제했습니다", kind: "warn", actionLabel: "실행 취소", action },
      { id: "p1", message: "그냥 알림", kind: "ok" },
    ]);
    render(Toasts);

    await fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(get(toasts).map((t) => t.id)).toEqual(["p1"]);
    expect(screen.queryByText("삭제했습니다")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
    expect(get(toasts)).toEqual([]);
    expect(screen.queryByText("그냥 알림")).toBeNull();
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
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools, tasks },
    });

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

  it("marks a background sub-agent on its card and in its accessible name", () => {
    const bgAgents: LiveAgentNode[] = [
      agents[0],
      { ...agents[1], background: true },
      { id: "sub2", parentId: "main", label: "요약 담당", status: "done", isMain: false },
    ];
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents: bgAgents, tools, tasks },
    });

    const bg = screen.getByText("조사 담당").closest(".agent-node")!;
    expect(bg.querySelector(".agent-bg-badge")?.textContent).toBe("백그라운드");
    expect(bg.getAttribute("aria-label")).toBe("백그라운드 에이전트 · 조사 담당 · 진행 중");
    // A foreground agent carries no such badge.
    const fg = screen.getByText("요약 담당").closest(".agent-node")!;
    expect(fg.querySelector(".agent-bg-badge")).toBeNull();
    expect(container.querySelectorAll(".agent-bg-badge")).toHaveLength(1);
  });

  it("omits the task-name span for an unnamed task (the 태스크 badge carries it)", () => {
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools, tasks },
    });

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
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools: lifted, tasks: [] },
    });

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
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools: withMemory, tasks: [] },
    });

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
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools: withCompact, tasks: [] },
    });

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
      render(ActivityTree, {
        props: { agentId: "main", agents: team, tools: teamTools, tasks: teamTasks },
      });

      const tester = card("@tester");
      const toggle = tester.querySelector("button.agent-toggle")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.querySelector(".agent-count")!.textContent).toBe("도구 3개 · 태스크 1개");
      expect(args(tester)).toEqual(["npm test"]);
      expect(tester.querySelector(".task-row")).toBeNull();
      // The teammate's name leads its accessible name as well as its card.
      expect(tester.getAttribute("aria-label")).toBe("에이전트 · @tester · general-purpose · 테스트 실행 · 진행 중");
      expect(args(card("Explore · 문서 조사"))).toEqual(["TODO · src"]);
      // The main agent's own rows are never folded.
      expect(screen.getByText("notes.md")).toBeTruthy();
      // A just-spawned agent has nothing to fold, so it gets no disclosure.
      expect(card("general-purpose · 막 시작함").querySelector("button")).toBeNull();
    });

    it("opens only the clicked card, and keeps it open when the same ids render afresh", async () => {
      const props = { agentId: "main", agents: team, tools: teamTools, tasks: teamTasks };
      const { unmount } = render(ActivityTree, { props });

      await fireEvent.click(screen.getByRole("button", { name: /@tester/ }));
      expect(card("@tester").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);
      expect(card("@tester").querySelector(".task-row")).toBeTruthy();
      expect(card("Explore · 문서 조사").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");

      // A live bubble finalizing into its stored message renders a new tree
      // over the same agent ids: the card the viewer opened stays open.
      unmount();
      render(ActivityTree, { props });
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);

      await fireEvent.click(screen.getByRole("button", { name: /@tester/ }));
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
      render(ActivityTree, { props: { agentId: "main", agents: nested, tools: nestedTools, tasks: [] } });

      const child = card("general-purpose · 초안");
      expect(card("워크플로 실행: spec").contains(child)).toBe(true);
      expect(child.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      expect(args(child)).toEqual(["draft.md"]);
    });

    it("keeps a lone sub-agent's rows in view with no disclosure", () => {
      render(ActivityTree, {
        props: { agentId: "main", agents: [team[0], team[1]], tools: teamTools, tasks: teamTasks },
      });

      const tester = card("@tester");
      expect(tester.querySelector("button")).toBeNull();
      expect(args(tester)).toEqual(["package.json", "npm ci", "npm test"]);
      expect(tester.querySelector(".task-row")).toBeTruthy();
    });

    it("folds as the second agent arrives, and a folded card follows its live rows", async () => {
      const { rerender } = render(ActivityTree, {
        props: { agentId: "main", agents: [team[0], team[1]], tools: teamTools, tasks: [] },
      });
      expect(args(card("@tester"))).toEqual(["package.json", "npm ci", "npm test"]);

      await rerender({ agents: [team[0], team[1], team[2]] });
      expect(args(card("@tester"))).toEqual(["npm test"]);

      // A new call replaces the latest row and bumps the count; a status flip
      // on the latest row shows through the fold.
      await rerender({
        tools: [
          ...teamTools.map((t) => (t.id === "t3" ? { ...t, status: "done" as const } : t)),
          { id: "t6", agentId: "a1", kind: "tool", label: "파일 쓰기", detail: "report.md", status: "running" },
        ],
      });
      expect(args(card("@tester"))).toEqual(["report.md"]);
      expect(card("@tester").querySelector(".agent-count")!.textContent).toBe("도구 4개");
      await rerender({
        tools: [
          ...teamTools,
          { id: "t6", agentId: "a1", kind: "tool", label: "파일 쓰기", detail: "report.md", status: "failed" },
        ],
      });
      expect(card("@tester").querySelector(".tool-row")!.getAttribute("data-status")).toBe("failed");
    });

    it("names the disclosure with the run status and the hidden count, never the decorative badge", () => {
      render(ActivityTree, {
        props: { agentId: "main", agents: team, tools: teamTools, tasks: teamTasks },
      });

      expect(card("@tester").querySelector("button")!.getAttribute("aria-label")).toBe(
        "에이전트 · @tester · general-purpose · 테스트 실행 · 진행 중 · 도구 3개 · 태스크 1개",
      );
    });

    it("folds a tasks-only card to its latest task", () => {
      const shells: LiveTaskRow[] = [
        { id: "s1", agentId: "a2", label: "빌드", status: "done" },
        { id: "s2", agentId: "a2", label: "e2e", detail: "npm run e2e", status: "running" },
      ];
      render(ActivityTree, {
        props: { agentId: "main", agents: team, tools: teamTools.filter((t) => t.agentId !== "a2"), tasks: shells },
      });

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
      const { container } = render(ActivityTree, {
        props: { agentId: "main", agents: legacy, tools: [], tasks: [] },
      });

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
    render(WhatsNewModal, {
      props: {
        releases: [
          {
            id: "2026-08-07",
            items: [
              { title: "브라우저 조작", body: "설명", action: "browser-guide" as const },
              { title: "액션 없는 항목", body: "버튼이 없어야 해요" },
            ],
          },
        ],
      },
    });

    // Exactly one deep-link button: the action-less item renders none.
    const buttons = screen.getAllByRole("button", { name: /설치 가이드 열기/ });
    expect(buttons).toHaveLength(1);

    await fireEvent.click(buttons[0]);

    // The click routes to 설정 → 권한·연결 and arms the one-shot flag the
    // access tab consumes to open the install guide.
    const state = readState();
    expect(state.view).toBe("settings");
    expect(state.settingsTab).toBe("access");
    expect(state.browserGuideRequested).toBe(true);

    replaceState({ view: "explore", settingsTab: "profile", browserGuideRequested: false });
  });
});

/* ------------------------------------------------------------------ */
/* SettingsGroupCard — the group admin's shared-skill channel section  */
/* ------------------------------------------------------------------ */

const GROUP_SKILL: GroupSharedSkill = {
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

function groupProps(role: "admin" | "member"): SettingsGroup {
  return {
    id: "g1",
    name: "플랫폼팀",
    role,
    knowledgeRepo: null,
    knowledgeBranch: null,
    knowledgeSelected: null,
    allowedMcpToolGroups: null,
    avatarSharing: true,
    agents: [],
    members: [
      {
        userId: "mate-1",
        username: "mate",
        displayName: "Mate",
        hasImage: false,
        role: "member",
        visibility: "group",
        joinedAt: null,
      },
    ],
  };
}

describe("SettingsGroupCard 공유 스킬", () => {
  /** Serve the channel listing; a POST/DELETE flips `blocked` for the reload. */
  function mockChannel(): { calls: { url: string; method: string; body?: string }[] } {
    const calls: { url: string; method: string; body?: string }[] = [];
    let listing: GroupSharedSkill[] = [{ ...GROUP_SKILL }];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.includes("/shared-skills/blocks")) {
        listing = listing.map((s) => ({ ...s, blocked: method === "POST" }));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.endsWith("/shared-skills")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ skills: listing }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return { calls };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    replaceState({ user: { id: "me-1" } as never });
  });

  it("shows a member's shares and blocks one through the group channel", async () => {
    const { calls } = mockChannel();
    const { container } = render(SettingsGroupCard, {
      props: { group: groupProps("admin"), githubHost: "github.com", reload: async () => {} },
    });

    await screen.findByText("Deck maker");
    expect(container.textContent).toContain("@mate");
    expect(container.textContent).toContain("전수 2회");
    expect(screen.queryByText("차단됨")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단" }));
    // Blocking is destructive-shaped, so it goes through the app confirm.
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    expect(get(confirmation)?.message).toContain("플랫폼팀");
    resolveConfirmation(true);

    await waitFor(() => expect(screen.getByText("차단됨")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/me/groups/g1/shared-skills/blocks");
    expect(JSON.parse(post!.body!)).toEqual({
      ownerUserId: "mate-1",
      skillName: "pptx-report",
    });
    // The row now offers the inverse action, keyed by the same pair.
    expect(screen.getByRole("button", { name: "Deck maker 차단 해제" })).toBeTruthy();
  });

  it("unblocks through the id/name path and hides the section from plain members", async () => {
    const { calls } = mockChannel();
    const { unmount } = render(SettingsGroupCard, {
      props: { group: groupProps("admin"), githubHost: "github.com", reload: async () => {} },
    });
    await screen.findByText("Deck maker");
    await fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);
    await waitFor(() => expect(screen.getByText("차단됨")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "Deck maker 차단 해제" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);
    await waitFor(() => expect(screen.queryByText("차단됨")).toBeNull());
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
      "/api/me/groups/g1/shared-skills/blocks/mate-1/pptx-report",
    );

    unmount();
    // A plain member sees no moderation section and never fetches the channel.
    const before = calls.length;
    render(SettingsGroupCard, {
      props: { group: groupProps("member"), githubHost: "github.com", reload: async () => {} },
    });
    await waitFor(() => expect(screen.getByText("플랫폼팀")).toBeTruthy());
    expect(screen.queryByText("공유 스킬")).toBeNull();
    expect(calls.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* CanvasPanel — a parked blocking ask must stay answerable            */
/* ------------------------------------------------------------------ */

function canvasPane(overrides: Record<string, unknown>, canvas: Record<string, unknown>): any {
  return {
    id: "p1",
    streaming: true,
    activeCanvasId: "cv1",
    canvases: [
      {
        id: "cv1",
        title: "질문",
        content: "골라 주세요",
        contentType: "markdown",
        controls: [
          { type: "buttons", id: "pick", label: "선택", options: [{ label: "A" }, { label: "B" }] },
        ],
        ...canvas,
      },
    ],
    ...overrides,
  };
}

describe("CanvasPanel", () => {
  const LOCKED = "아바타 응답이 끝난 뒤 보낼 수 있습니다.";

  it("a parked blocking canvas stays answerable while the run streams", async () => {
    render(CanvasPanel, {
      props: {
        pane: canvasPane({}, { pending: true, requestId: "rq1", runId: "rn1", interaction: "blocking" }),
      },
    });

    // The run is parked on THIS form: locking it on pane.streaming would deadlock
    // the question (the run resumes only via /api/chat/respond).
    const optA = screen.getByRole("button", { name: /A/ }) as HTMLButtonElement;
    expect(optA.disabled).toBe(false);
    await fireEvent.click(optA);

    expect((screen.getByRole("button", { name: "보내기" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "건너뛰기" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("보낼 준비가 됐습니다.")).toBeTruthy();
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("an async canvas locks its form while the avatar is responding", () => {
    render(CanvasPanel, {
      props: { pane: canvasPane({}, { pending: false, interaction: "async" }) },
    });

    // No park to unblock, so the answer rides a NEW turn — which must wait.
    expect((screen.getByRole("button", { name: /A/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "보내기" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("the edit path stays locked while parked (edits ride a new turn)", () => {
    const { container } = render(CanvasPanel, {
      props: {
        pane: canvasPane({}, { pending: true, requestId: "rq1", runId: "rn1", editable: true }),
      },
    });

    const textarea = container.querySelector(
      'textarea[placeholder="내용을 수정해 아바타에게 보내세요"]',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(true); // submitCanvasEdit → sendMessage needs the turn to end
    expect((screen.getByRole("button", { name: /A/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an html canvas renders as its own sandboxed page, never into the app's DOM", () => {
    const { container } = render(CanvasPanel, {
      props: {
        pane: canvasPane(
          { streaming: false },
          { title: "목업", content: "<style>body{display:none}</style><div class=\"card\">카드</div>", contentType: "html", controls: [] },
        ),
      },
    });

    const frame = container.querySelector("iframe.canvas-html-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); // never allow-scripts
    expect(frame.getAttribute("title")).toBe("목업");
    expect(frame.getAttribute("srcdoc")).toContain("<style>body{display:none}</style>");
    // The page's CSS lives only in the frame's document: none of it reaches the app.
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector(".card")).toBeNull();
  });

  it("an svg canvas draws in its own shadow root, and export still finds the drawing", async () => {
    const drawing =
      '<svg viewBox="0 0 10 10"><style>.shape{fill:red} .canvas-panel{display:none}</style>' +
      '<rect class="shape" width="10" height="10"/></svg>';
    const { container } = render(CanvasPanel, {
      props: {
        pane: canvasPane({ streaming: false }, { title: "도형", content: drawing, contentType: "svg", controls: [] }),
      },
    });

    const host = container.querySelector(".canvas-content .canvas-svg") as HTMLElement;
    expect(host.hasAttribute("data-fit")).toBe(true);
    expect(host.shadowRoot?.querySelector("svg style")?.textContent).toContain(".canvas-panel{display:none}");
    // The drawing and its <style> live only in the shadow root, never the app's DOM.
    expect(container.querySelector(".shape")).toBeNull();
    expect(container.querySelector("style")).toBeNull();

    // SVG export serializes the shadow root's <svg>, its own <style> included.
    const hrefs: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href);
    });
    try {
      await fireEvent.click(screen.getByRole("button", { name: "SVG" }));
    } finally {
      click.mockRestore();
    }
    expect(hrefs).toHaveLength(1);
    expect(atob(hrefs[0].split(",")[1])).toContain(".shape{fill:red}");
  });
});
