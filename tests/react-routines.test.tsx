// React component tests — run in the vitest "react" project (jsdom +
// @vitejs/plugin-react + @testing-library/react; see vitest.config.ts).
//
// The routines screens: the create/edit modal's schedule builder and the
// routines view's grouping + status chips. Ported from the `RoutineModal` and
// `RoutinesView` blocks of tests/svelte-components.test.ts.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RoutineModal from "../src/client/src/components/RoutineModal";
import RoutinesView from "../src/client/src/views/RoutinesView";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { RoutineJob } from "../src/client/src/lib/types";

/* ------------------------------------------------------------------ */
/* RoutineModal — schedule builder                                     */
/* ------------------------------------------------------------------ */

describe("RoutineModal", () => {
  it("makes content outside the modal inert and restores it on close", () => {
    const background = document.createElement("button");
    background.textContent = "배경 작업";
    document.body.append(background);

    const modal = render(<RoutineModal routine={null} />);
    expect(background.inert).toBe(true);

    modal.unmount();
    expect(background.inert).toBe(false);
    background.remove();
  });

  it("offers a one-time date/time schedule and rejects a past slot", async () => {
    render(<RoutineModal routine={null} />);

    fireEvent.click(screen.getByRole("radio", { name: "한 번만" }));
    const date = screen.getByLabelText("실행 날짜") as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText("실행 시각")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("작업 프롬프트"), {
      target: { value: "출시 상태를 확인해줘" },
    });
    expect((screen.getByRole("button", { name: "예약 작업 추가" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(date, { target: { value: "2000-01-01" } });
    expect(screen.getByText("한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "예약 작업 추가" }) as HTMLButtonElement).disabled).toBe(true);
    // The plain-language echo only appears for a schedule that could actually run.
    expect(document.querySelector(".schedule-echo")).toBeNull();
  });

  it("echoes the assembled schedule in plain language and seeds create mode from a preset", async () => {
    render(
      <RoutineModal
        routine={null}
        preset={{ name: "주간 회고", prompt: "회고 초안", scheduleKind: "weekly", daysOfWeek: [5], time: "18:00" }}
      />,
    );

    expect((screen.getByLabelText("예약 작업 이름") as HTMLInputElement).value).toBe("주간 회고");
    expect((screen.getByLabelText("작업 프롬프트") as HTMLTextAreaElement).value).toBe("회고 초안");
    expect(screen.getByRole("radio", { name: "매주" }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".schedule-echo")?.textContent).toContain("매주 금 18:00 (KST)");

    // Deselecting the only weekday makes the schedule unsavable, so the echo goes.
    fireEvent.click(screen.getByRole("button", { name: "금" }));
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
    };
    render(<RoutineModal routine={routine} />);

    expect(screen.queryByRole("button", { name: "지금 실행" })).toBeNull();
    fireEvent.change(screen.getByLabelText("예약 작업 이름"), {
      target: { value: "지난 작업 이름 변경" },
    });
    expect((screen.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* RoutinesView — always-on lifecycle grouping + status filter chips   */
/* ------------------------------------------------------------------ */

describe("RoutinesView", () => {
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

    render(<RoutinesView />);

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
    fireEvent.click(completedFilter);
    expect(readState().routineFilter).toBe("completed");
    await waitFor(() => expect(screen.queryByText("매일 점검")).toBeNull());
    expect(groupHeads()).toEqual(["지난 실행 1"]);
    expect(screen.getByText("백업 확인")).toBeTruthy();
  });
});
