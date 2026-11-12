// The rail's conversation list: date groups (오늘 / 어제 / …) and prefetch on
// intent. jsdom never lays out and has no real pointer — the real-browser half
// (one request on hover, none on click) is checked with Playwright, not here.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell";
import { resolveConfirmation } from "../src/client/src/lib/confirm";
import { invalidateConversationPrefetch } from "../src/client/src/lib/conversationPrefetch";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { ConversationSummary, User } from "../src/client/src/lib/types";

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

// LOCAL calendar fields throughout, so the suite passes in any TZ.
const local = (d: number, h = 12, min = 0) => new Date(2026, 10, d, h, min);
const NOW = local(11, 15, 0);

function conv(id: string, title: string, updatedAt: Date, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title,
    avatarUserId: "owner-1",
    avatarDisplayName: "Noah",
    updatedAt: updatedAt.toISOString(),
    isRoutine: false,
    routineId: null,
    routinePrompt: null,
    activeRun: null,
    ...extra,
  };
}

function setDesktopViewport(): void {
  const media = {
    matches: true,
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

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/** The rail's server: the list, plus the three requests an open makes. */
function useServer(conversations: ConversationSummary[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url === "/api/conversations") return jsonRes({ conversations });
      if (url.startsWith("/api/messages")) {
        const id = new URL(url, "http://x").searchParams.get("conversationId");
        return jsonRes({
          messages: [{ id: `m-${id}`, role: "assistant", content: "답변", response: null, conversationId: id, createdAt: "t" }],
          canvases: [],
        });
      }
      if (url.startsWith("/api/avatars/")) return jsonRes({ avatar: { id: "owner-1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      throw new Error(`unhandled fetch: ${url}`);
    }),
  );
  return {
    urls,
    messageRequests: (id: string) => urls.filter((url) => url === `/api/messages?conversationId=${id}`).length,
  };
}

/**
 * Let the mount's list load and any pending promise chain settle (fake timers).
 * Inside `act`, so what the chain writes is rendered — and a row or group that
 * left is out of the DOM — before the next assertion. (Never Testing Library's
 * `waitFor` in this file: it waits on a `setTimeout`, which is faked here.)
 */
const settle = (ms = 1) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mountRail(conversations: ConversationSummary[]) {
  setDesktopViewport();
  replaceState({ conversations });
  const server = useServer(conversations);
  const view = render(<Shell user={user} view="explore" />);
  await settle();
  return { ...server, ...view };
}

const headings = () => [...document.querySelectorAll("#rail-conversation-list h3")].map((h) => h.textContent);
const rowsOf = (label: string) =>
  within(screen.getByRole("list", { name: label }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".conv-name")?.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  replaceState({ user, conversations: [], chatPanes: [], activePaneId: null });
  invalidateConversationPrefetch();
});

afterEach(() => {
  invalidateConversationPrefetch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Shell conversation date groups", () => {
  const list = [
    conv("c-today-2", "오늘 둘", local(11, 14)),
    conv("c-today-1", "오늘 하나", local(11, 9)),
    conv("c-yday", "어제 것", local(10, 18)),
    conv("c-week", "지난주 것", local(6, 10)),
    conv("c-month", "지난달 것", new Date(2026, 9, 20, 10)),
    conv("c-old", "오래된 것", new Date(2026, 0, 5, 10)),
  ];

  it("puts the rows under 오늘 / 어제 / 지난 7일 / 지난 30일 / 그 이전, each a list labelled by its heading", async () => {
    await mountRail(list);
    expect(headings()).toEqual(["오늘", "어제", "지난 7일", "지난 30일", "그 이전"]);
    expect(rowsOf("오늘")).toEqual(["오늘 둘", "오늘 하나"]);
    expect(rowsOf("어제")).toEqual(["어제 것"]);
    expect(rowsOf("지난 7일")).toEqual(["지난주 것"]);
    expect(rowsOf("지난 30일")).toEqual(["지난달 것"]);
    expect(rowsOf("그 이전")).toEqual(["오래된 것"]);
    // Real headings for assistive tech…
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(headings());
    // …and nothing more: not focusable, not a control.
    for (const heading of document.querySelectorAll("#rail-conversation-list h3")) {
      expect(heading.hasAttribute("tabindex")).toBe(false);
      expect(heading.closest("button, a, [role=button]")).toBeNull();
      expect(heading.querySelector("button, a")).toBeNull();
    }
    // The rows are list items of their group's list, not of the scroll container.
    expect(document.getElementById("rail-conversation-list")?.hasAttribute("role")).toBe(false);
    // The header keeps counting every conversation.
    expect(document.querySelector(".rail-section-count")?.textContent).toBe("6");
  });

  it("leaves a group out when it has no rows, and keeps routine conversations out of the rail", async () => {
    await mountRail([list[0], list[3], conv("c-routine", "예약 실행", local(11, 13), { isRoutine: true })]);
    expect(headings()).toEqual(["오늘", "지난 7일"]);
    expect(screen.queryByRole("button", { name: /예약 실행/ })).toBeNull();
  });

  it("filters inside the groups: empty groups disappear, and no match shows the empty state", async () => {
    await mountRail(list);
    const search = screen.getByRole("searchbox", { name: "대화 검색" });
    fireEvent.change(search, { target: { value: "것" } });
    await settle(0);
    expect(headings()).toEqual(["어제", "지난 7일", "지난 30일", "그 이전"]);
    expect(document.getElementById("rail-conversation-status")?.textContent).toContain("검색 결과 4개");

    fireEvent.change(search, { target: { value: "오늘 하나" } });
    await settle(0);
    expect(headings()).toEqual(["오늘"]);
    expect(rowsOf("오늘")).toEqual(["오늘 하나"]);

    fireEvent.change(search, { target: { value: "없는 대화" } });
    await settle(0);
    expect(headings()).toEqual([]);
    expect(screen.getByText("검색 결과가 없습니다.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "대화 검색어 지우기" }));
    await settle(0);
    expect(headings()).toEqual(["오늘", "어제", "지난 7일", "지난 30일", "그 이전"]);
  });

  it("regroups when the local date changes while the app stays open", async () => {
    vi.setSystemTime(local(11, 23, 59));
    await mountRail([conv("c-a", "밤 대화", local(11, 23, 50)), conv("c-b", "어제 대화", local(10, 23, 50))]);
    expect(headings()).toEqual(["오늘", "어제"]);
    expect(rowsOf("오늘")).toEqual(["밤 대화"]);

    // Past midnight, with no reload and no new list.
    await settle(61_000);
    expect(headings()).toEqual(["어제", "지난 7일"]);
    expect(rowsOf("어제")).toEqual(["밤 대화"]);
    expect(rowsOf("지난 7일")).toEqual(["어제 대화"]);

    // And again the night after — the timer re-arms itself.
    await settle(24 * 60 * 60 * 1000);
    expect(headings()).toEqual(["지난 7일"]);
  });

  it("regroups as soon as the tab comes back after the date changed (a sleeping laptop runs no timers)", async () => {
    vi.setSystemTime(local(11, 23, 59));
    await mountRail([conv("c-a", "밤 대화", local(11, 23, 50))]);
    expect(headings()).toEqual(["오늘"]);
    // The clock jumps without the timer having run.
    vi.setSystemTime(local(12, 8, 0));
    expect(headings()).toEqual(["오늘"]);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(0);
    expect(headings()).toEqual(["어제"]);
  });

  it("moves a row to its new group when a reloaded list says it was active again", async () => {
    await mountRail(list);
    expect(rowsOf("그 이전")).toEqual(["오래된 것"]);
    await act(async () =>
      replaceState({
        conversations: [{ ...list[5], updatedAt: local(11, 14, 30).toISOString() }, ...list.slice(0, 5)],
      }),
    );
    await settle(0);
    expect(headings()).toEqual(["오늘", "어제", "지난 7일", "지난 30일"]);
    expect(rowsOf("오늘")).toEqual(["오래된 것", "오늘 둘", "오늘 하나"]);
  });
});

describe("Shell conversation deletion motion", () => {
  // Which node leaves with motion, and when — the gate. How it LOOKS (the height
  // closing, the rows below rising without a jump) is a real-browser fact: jsdom
  // never lays out. The exit is the only 200 ms animation the rail starts.
  const list = [
    conv("c-today-2", "오늘 둘", local(11, 14)),
    conv("c-today-1", "오늘 하나", local(11, 9)),
    conv("c-yday", "어제 것", local(10, 18)),
    conv("c-week", "지난주 것", local(6, 10)),
  ];

  afterEach(() => {
    delete document.documentElement.dataset.motion;
    vi.restoreAllMocks();
  });

  async function mountDeletable() {
    await mountRail(list);
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => (init?.method === "DELETE" ? jsonRes({ ok: true }) : base(input as RequestInfo, init))),
    );
    return vi.spyOn(Element.prototype, "animate");
  }

  async function deleteRow(title: string) {
    fireEvent.click(screen.getByRole("button", { name: `대화 삭제: ${title}` }));
    await settle();
    act(() => resolveConfirmation(true));
    await settle(5);
  }

  const rowNamed = (title: string) => screen.getByRole("button", { name: `대화 열기: ${title}` }).closest(".conv-item")!;
  /** The nodes that left with the exit (its duration marks it). */
  const exited = (animate: { mock: { calls: unknown[][]; contexts: unknown[] } }) =>
    animate.mock.calls.flatMap((call, index) => ((call[1] as KeyframeAnimationOptions | undefined)?.duration === 200 ? [animate.mock.contexts[index]] : []));

  it("the row the viewer deletes leaves with motion; its group and the other rows do not", async () => {
    const animate = await mountDeletable();
    const row = rowNamed("오늘 둘");
    const group = row.closest(".conv-group")!;
    await deleteRow("오늘 둘");
    expect(rowsOf("오늘")).toEqual(["오늘 하나"]);
    expect(exited(animate)).toEqual([row]);
    expect(exited(animate)).not.toContain(group);
  });

  it("a deletion that empties its date group takes the whole group out with motion (heading included)", async () => {
    const animate = await mountDeletable();
    const group = rowNamed("어제 것").closest(".conv-group")!;
    await deleteRow("어제 것");
    expect(headings()).toEqual(["오늘", "지난 7일"]);
    // The row's own exit is local to its group's list and does not run when the
    // group goes — the group is what moves.
    expect(exited(animate)).toEqual([group]);
  });

  it("is instant under the app's 움직임 줄이기", async () => {
    const animate = await mountDeletable();
    document.documentElement.dataset.motion = "reduce";
    await deleteRow("오늘 둘");
    await deleteRow("어제 것");
    expect(headings()).toEqual(["오늘", "지난 7일"]);
    expect(exited(animate)).toEqual([]);
  });

  it("rows that leave for any other reason (a search filter) never move", async () => {
    const animate = await mountDeletable();
    fireEvent.change(screen.getByRole("searchbox", { name: "대화 검색" }), { target: { value: "오늘 하나" } });
    await settle(5);
    expect(headings()).toEqual(["오늘"]);
    expect(exited(animate)).toEqual([]);
  });
});

describe("Shell conversation prefetch on intent", () => {
  const list = [
    conv("c-one", "첫째", local(11, 14)),
    conv("c-two", "둘째", local(11, 13)),
    conv("c-run", "달리는 중", local(11, 12), { activeRun: {} }),
  ];
  const rowOf = (title: string) => screen.getByRole("button", { name: new RegExp(`^대화 열기: ${title}`) }).closest(".conv-item")!;
  const openButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^대화 열기: ${title}`) });

  it("hover starts ONE load after a short dwell, and the click reuses it", async () => {
    const server = await mountRail(list);
    fireEvent.pointerEnter(rowOf("첫째"));
    await settle(100);
    expect(server.messageRequests("c-one")).toBe(0);
    await settle(30);
    expect(server.messageRequests("c-one")).toBe(1);

    fireEvent.click(openButton("첫째"));
    await settle(5);
    expect(server.messageRequests("c-one")).toBe(1);
    expect(server.urls.filter((url) => url.startsWith("/api/avatars/"))).toHaveLength(1);
    expect(readState().chatPanes.map((pane) => pane.conversationId)).toEqual(["c-one"]);
    expect(readState().chatPanes[0].messages).toHaveLength(1);
    // The reattach probe still runs after the open.
    expect(server.urls.filter((url) => url.startsWith("/api/chat/runs"))).toHaveLength(1);
    // The row is not left locked.
    expect((openButton("첫째") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a pointer that only passes over a row starts nothing", async () => {
    const server = await mountRail(list);
    fireEvent.pointerEnter(rowOf("첫째"));
    await settle(60);
    fireEvent.pointerLeave(rowOf("첫째"));
    await settle(500);
    expect(server.messageRequests("c-one")).toBe(0);
  });

  it("a press starts the load at once; keyboard focus after the dwell", async () => {
    const server = await mountRail(list);
    fireEvent.pointerDown(openButton("첫째"));
    await settle(0);
    expect(server.messageRequests("c-one")).toBe(1);

    openButton("둘째").focus();
    await settle(100);
    expect(server.messageRequests("c-two")).toBe(0);
    await settle(30);
    expect(server.messageRequests("c-two")).toBe(1);
    // Focus moving on within the dwell cancels it for the row it left.
    expect(server.urls.filter((url) => url.startsWith("/api/messages"))).toHaveLength(2);
  });

  it("the split button's press prefetches too, and adding to the split reuses it", async () => {
    const server = await mountRail(list);
    fireEvent.click(openButton("첫째"));
    await settle(5);
    const split = screen.getByRole("button", { name: "분할 대화에 추가: 둘째" });
    fireEvent.pointerDown(split);
    await settle(0);
    expect(server.messageRequests("c-two")).toBe(1);
    fireEvent.click(split);
    await settle(5);
    expect(server.messageRequests("c-two")).toBe(1);
    expect(readState().chatPanes.map((pane) => pane.conversationId)).toEqual(["c-one", "c-two"]);
  });

  it("never prefetches a row with a running turn or the conversation open in a pane", async () => {
    const server = await mountRail(list);
    fireEvent.pointerEnter(rowOf("달리는 중"));
    fireEvent.pointerDown(openButton("달리는 중"));
    await settle(500);
    expect(server.messageRequests("c-run")).toBe(0);

    fireEvent.click(openButton("첫째"));
    await settle(5);
    expect(server.messageRequests("c-one")).toBe(1);
    fireEvent.pointerLeave(rowOf("첫째"));
    fireEvent.pointerEnter(rowOf("첫째"));
    fireEvent.pointerDown(openButton("첫째"));
    await settle(500);
    expect(server.messageRequests("c-one")).toBe(1);
  });

  it("a touch press or a non-primary button starts nothing", async () => {
    const server = await mountRail(list);
    fireEvent.pointerDown(openButton("첫째"), { button: 2 });
    if (typeof PointerEvent !== "undefined") {
      fireEvent.pointerEnter(rowOf("첫째"), { pointerType: "touch" });
      fireEvent.pointerDown(openButton("첫째"), { pointerType: "touch" });
    }
    await settle(500);
    expect(server.messageRequests("c-one")).toBe(0);
    // The tap itself still opens it.
    fireEvent.click(openButton("첫째"));
    await settle(5);
    expect(server.messageRequests("c-one")).toBe(1);
    expect(readState().chatPanes[0].conversationId).toBe("c-one");
  });

  it("a rename replaces the list, which drops what was prefetched", async () => {
    const server = await mountRail(list);
    fireEvent.pointerDown(openButton("둘째"));
    await settle(5);
    expect(server.messageRequests("c-two")).toBe(1);

    const before = readState().conversations;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input);
        server.urls.push(url);
        if (init.method === "PATCH") return jsonRes({ conversation: { ...list[0], title: "새 이름" } });
        if (url.startsWith("/api/messages")) return jsonRes({ messages: [], canvases: [] });
        if (url.startsWith("/api/avatars/")) return jsonRes({ avatar: { id: "owner-1", alias: "노아", isOwn: true } });
        return jsonRes({ run: null });
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "대화 이름 바꾸기: 첫째" }));
    const input = screen.getByRole("textbox", { name: "대화 이름" });
    fireEvent.change(input, { target: { value: "새 이름" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle(5);
    expect(readState().conversations).not.toBe(before);
    expect(openButton("새 이름")).toBeTruthy();

    fireEvent.click(openButton("둘째"));
    await settle(5);
    expect(server.messageRequests("c-two")).toBe(2);
  });
});
