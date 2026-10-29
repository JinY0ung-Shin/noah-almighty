import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { ConversationSummary, User } from "../src/client/src/lib/types.js";

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
  groupKnowledgeOffDefault: [],
  modelDefault: null,
  effortDefault: null,
  mcpToolGroupsDefault: null,
  allowedMcpToolGroups: null,
  secretNames: [],
  shellExposedSecretNames: [],
  browserSecrets: [],
  sshPublicKey: null,
  groups: [],
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

function setDesktopViewport(matches: boolean): void {
  const media = {
    matches,
    media: "(min-width: 861px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
}

beforeEach(() => {
  replaceState({ conversations: [], chatPanes: [], activePaneId: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ conversations: [] }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shell rail controls", () => {
  it("collapses and reopens the desktop rail through the parent preference callback", async () => {
    setDesktopViewport(true);
    const onRailCollapsedChange = vi.fn();
    const first = render(Shell, {
      props: { user, view: "explore", railCollapsed: false, onRailCollapsedChange },
    });

    await fireEvent.click(screen.getByRole("button", { name: "왼쪽 메뉴 접기" }));
    expect(onRailCollapsedChange).toHaveBeenCalledWith(true);
    first.unmount();

    render(Shell, {
      props: { user, view: "explore", railCollapsed: true, onRailCollapsedChange },
    });
    expect(document.getElementById("rail")?.getAttribute("aria-hidden")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    expect(onRailCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it("uses the same controls as an open/close drawer on mobile without changing the desktop preference", async () => {
    setDesktopViewport(false);
    const onRailCollapsedChange = vi.fn();
    const onMobileRailOpenChange = vi.fn();
    render(Shell, {
      props: { user, view: "explore", railCollapsed: true, onRailCollapsedChange, onMobileRailOpenChange },
    });

    const open = screen.getByRole("button", { name: "메뉴 열기" });
    const rail = document.getElementById("rail")!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(rail.inert).toBe(true);
    expect(document.getElementById("rail-conversation-list")?.hasAttribute("role")).toBe(false);
    await fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(rail.hasAttribute("aria-hidden")).toBe(false);
    expect(rail.inert).toBe(false);
    expect(open.inert).toBe(true);
    expect(onMobileRailOpenChange).toHaveBeenCalledWith(true);

    const close = within(rail).getByRole("button", { name: "메뉴 닫기" });
    await vi.waitFor(() => expect(document.activeElement).toBe(close));
    await fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(rail.contains(document.activeElement)).toBe(true);

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(rail.inert).toBe(true);
    expect(open.inert).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(open));
    expect(onRailCollapsedChange).not.toHaveBeenCalled();
    expect(onMobileRailOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("makes conversation search reversible and gives repeated row actions contextual names", async () => {
    setDesktopViewport(true);
    const conversations = [
      {
        id: "conv-alpha",
        title: "Alpha 계획",
        avatarDisplayName: "Noah",
        updatedAt: "2026-07-13T12:00:00.000Z",
        isRoutine: false,
      },
      {
        id: "conv-beta",
        title: "Beta 점검",
        avatarDisplayName: "Noah",
        updatedAt: "2026-07-13T11:00:00.000Z",
        isRoutine: false,
      },
    ];
    replaceState({ conversations: conversations as any });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ conversations }),
      })),
    );

    render(Shell, { props: { user, view: "explore" } });
    await screen.findByRole("button", { name: "대화 열기: Alpha 계획" });

    const search = screen.getByRole("searchbox", { name: "대화 검색" }) as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "alpha" } });
    expect(document.getElementById("rail-conversation-status")?.textContent).toContain("검색 결과 1개");
    expect(screen.queryByRole("button", { name: "대화 열기: Beta 점검" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "대화 검색어 지우기" }));
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("button", { name: "분할 대화에 추가: Alpha 계획" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 이름 바꾸기: Alpha 계획" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 삭제: Alpha 계획" })).toBeTruthy();
  });
});

describe("Shell conversation live-run badge", () => {
  const row = {
    avatarUserId: "owner-1",
    avatarDisplayName: "Noah",
    updatedAt: "2026-07-13T12:00:00.000Z",
    isRoutine: false,
    routineId: null,
    routinePrompt: null,
  };

  it("names the running state in words, and leaves an idle row bare", async () => {
    setDesktopViewport(true);
    const conversations: ConversationSummary[] = [
      { ...row, id: "conv-bg", title: "빌드", activeRun: {} },
      { ...row, id: "conv-fg", title: "요약", activeRun: {} },
      { ...row, id: "conv-idle", title: "지난 대화", activeRun: null },
      // An older server that doesn't send the field at all.
      { ...row, id: "conv-legacy", title: "옛 대화" },
    ];
    replaceState({ conversations });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations }) })),
    );

    render(Shell, { props: { user, view: "explore" } });

    // The badge text rides the row button's accessible name — its aria-label
    // overrides the badge markup for screen readers.
    await screen.findByRole("button", { name: "대화 열기: 빌드 · 응답 생성 중" });
    expect(screen.getByRole("button", { name: "대화 열기: 요약 · 응답 생성 중" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 열기: 지난 대화" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 열기: 옛 대화" })).toBeTruthy();

    const badges = [...document.querySelectorAll(".conv-live")];
    expect(badges.map((badge) => badge.textContent?.trim())).toEqual([
      "응답 생성 중",
      "응답 생성 중",
    ]);
    expect(badges.map((badge) => badge.getAttribute("title"))).toEqual([
      "응답 생성 중",
      "응답 생성 중",
    ]);
  });
});

describe("Shell admin presence badge", () => {
  const adminUser = { ...user, roles: ["admin"] } satisfies User;
  const other = {
    id: "mate-1",
    username: "mate",
    displayName: "정민",
    hasImage: false,
    lastSeenAt: new Date().toISOString(),
  };

  afterEach(() => {
    replaceState({ adminPresence: null });
  });

  it("stays hidden for a non-admin even when presence is in state", () => {
    setDesktopViewport(true);
    replaceState({ adminPresence: { windowMinutes: 60, users: [other] } });
    render(Shell, { props: { user, view: "explore" } });
    expect(screen.queryByText(/^접속 /)).toBeNull();
  });

  it("counts other people only and lists them when expanded", async () => {
    setDesktopViewport(true);
    replaceState({
      adminPresence: {
        windowMinutes: 60,
        // The viewer's own row must not inflate the count.
        users: [other, { ...adminUser, lastSeenAt: new Date().toISOString() }],
      },
    });
    render(Shell, { props: { user: adminUser, view: "explore" } });

    const toggle = screen.getByRole("button", { name: /접속 1/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("rail-presence-list")).toBeNull();

    await fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById("rail-presence-list")!;
    expect(within(list).getByText("정민")).toBeTruthy();
    expect(within(list).getByText("방금")).toBeTruthy();
    expect(within(list).queryByText("Owner")).toBeNull();
  });

  it("shows a muted alone state when the admin is the only one present", async () => {
    setDesktopViewport(true);
    replaceState({
      adminPresence: { windowMinutes: 60, users: [{ ...adminUser, lastSeenAt: new Date().toISOString() }] },
    });
    render(Shell, { props: { user: adminUser, view: "explore" } });

    const toggle = screen.getByRole("button", { name: /접속 0/ });
    expect(toggle.querySelector(".rail-presence-dot.alone")).toBeTruthy();
    await fireEvent.click(toggle);
    // The window is rendered in whole hours; "60분" / "1시간분" would both be wrong.
    expect(document.getElementById("rail-presence-list")?.textContent).toBe(
      "최근 1시간 동안 나 혼자 있었습니다.",
    );
  });

  it("labels the window in whole hours, falling back to minutes below an hour", async () => {
    setDesktopViewport(true);
    const self = { ...adminUser, lastSeenAt: new Date().toISOString() };

    replaceState({ adminPresence: { windowMinutes: 60, users: [self] } });
    const hour = render(Shell, { props: { user: adminUser, view: "explore" } });
    expect(screen.getByRole("button", { name: /접속 0/ }).getAttribute("title")).toContain("최근 1시간 안에");
    hour.unmount();

    replaceState({ adminPresence: { windowMinutes: 120, users: [self] } });
    const twoHours = render(Shell, { props: { user: adminUser, view: "explore" } });
    expect(screen.getByRole("button", { name: /접속 0/ }).getAttribute("title")).toContain("최근 2시간 안에");
    twoHours.unmount();

    // A sub-hour (or non-whole-hour) window must still read in minutes.
    replaceState({ adminPresence: { windowMinutes: 3, users: [self] } });
    render(Shell, { props: { user: adminUser, view: "explore" } });
    expect(screen.getByRole("button", { name: /접속 0/ }).getAttribute("title")).toContain("최근 3분 안에");
  });
});
