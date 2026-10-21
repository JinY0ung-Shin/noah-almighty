// 할 일 UI: the rail entry + badge, the detailed tab, and the chat overlay with
// its composer switch. A small fake /api/me/todos server stands in for the
// backend so every assertion goes through the real store actions (lib/todos.ts).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell.svelte";
import TodosView from "../src/client/src/views/TodosView.svelte";
import ChatView from "../src/client/src/views/ChatView.svelte";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import {
  loadTodos,
  noteTodoToolEnd,
  noteTodoToolStart,
  resetTodoClientState,
  setTodoOverlayOpen,
} from "../src/client/src/lib/todos.js";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import type { ChatPane, User } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";
import { isOpenTodo, type TodoCounts, type TodoItem } from "../src/shared/todos.js";

const PRISTINE = structuredClone(readState());
const TODAY = "2026-10-09";

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

let seq = 0;
function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  seq += 1;
  return {
    id: overrides.id ?? `todo-${seq}`,
    title: `할 일 ${seq}`,
    note: "",
    status: "todo",
    priority: "normal",
    dueDate: null,
    tags: [],
    source: "user",
    sourceConversationId: null,
    createdAt: `2026-10-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function countsOf(items: TodoItem[]): TodoCounts {
  const open = items.filter(isOpenTodo);
  return {
    open: open.length,
    inProgress: open.filter((item) => item.status === "in_progress").length,
    overdue: open.filter((item) => item.dueDate && item.dueDate < TODAY).length,
    dueToday: open.filter((item) => item.dueDate === TODAY).length,
    done: items.filter((item) => item.status === "done").length,
    dropped: items.filter((item) => item.status === "dropped").length,
  };
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/** A stateful stand-in for routes/todos.ts; anything else answers the empty bodies ChatView's mount loads expect. */
function fakeServer(initial: TodoItem[]) {
  let items = [...initial];
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let gate: Promise<void> | null = null;
  const snapshot = () => ({ todayKst: TODAY, counts: countsOf(items) });
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    if (gate && method !== "GET") await gate;
    if (url === "/api/me/todos" && method === "GET") return jsonRes({ todos: items, ...snapshot() });
    if (url === "/api/me/todos" && method === "POST") {
      const created = todo({
        title: String(body?.title),
        priority: (body?.priority as TodoItem["priority"]) ?? "normal",
        dueDate: (body?.dueDate as string | null) ?? null,
        tags: (body?.tags as string[]) ?? [],
      });
      items.push(created);
      return jsonRes({ todo: created, ...snapshot() }, 201);
    }
    const clearing = { "/api/me/todos/completed": "done", "/api/me/todos/dropped": "dropped" }[url];
    if (clearing && method === "DELETE") {
      const removed = items.filter((item) => item.status === clearing).length;
      items = items.filter((item) => item.status !== clearing);
      return jsonRes({ removed, ...snapshot() });
    }
    const match = /^\/api\/me\/todos\/([^/]+)$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const current = items.find((item) => item.id === id);
      if (!current) return jsonRes({ error: "할 일을 찾을 수 없습니다." }, 404);
      if (method === "DELETE") {
        items = items.filter((item) => item.id !== id);
        return jsonRes({ ok: true, ...snapshot() });
      }
      const next = { ...current, ...body } as TodoItem;
      if (body?.status !== undefined && body.status !== current.status) {
        next.closedAt = isOpenTodo(next) ? null : "2026-10-09T03:00:00.000Z";
      }
      items = items.map((item) => (item.id === id ? next : item));
      return jsonRes({ todo: next, ...snapshot() });
    }
    return jsonRes({ avatars: [], conversations: [], messages: [], skills: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    get items() {
      return items;
    },
    /** Hold every write's response until the returned release is called. */
    holdWrites(): () => void {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    /** What an avatar's tool (or another tab) did server-side; the client learns of it on its next GET. */
    setItems(next: TodoItem[]) {
      items = [...next];
    },
  };
}

function seedLoaded(items: TodoItem[]) {
  updateState((state) => {
    state.todos = { items, todayKst: TODAY, counts: countsOf(items), loaded: true };
  });
}

function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
}

/** A list row's button: named by its visible content — the title first, then due/priority/tags. */
function rowName(title: string): RegExp {
  return new RegExp(`^${title}`);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  // The store's load/write bookkeeping and the card's motion state are module-level.
  resetTodoClientState();
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user, conversations: [], chatPanes: [], activePaneId: null });
  window.localStorage.clear();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rail entry", () => {
  it("sits right below 대화 and badges overdue + due today only", async () => {
    fakeServer([]);
    seedLoaded([
      todo({ dueDate: "2026-10-01" }),
      todo({ dueDate: TODAY }),
      todo({ dueDate: TODAY }),
      todo({ dueDate: "2026-12-01" }),
      todo(),
    ]);
    stubMatchMedia(true); // desktop rail: expanded, so not aria-hidden
    render(Shell, { props: { user, view: "explore" } });
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.querySelector("span")?.textContent);
    expect(labels.indexOf("할 일")).toBe(labels.indexOf("대화") + 1);
    const entry = within(nav).getByRole("button", { name: /할 일/ });
    const badge = entry.querySelector(".nav-badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("title")).toBe("마감 지남 1개 · 오늘 마감 2개");

    await fireEvent.click(entry);
    expect(readState().view).toBe("todos");
  });

  it("shows no badge when nothing is overdue or due today", () => {
    fakeServer([]);
    seedLoaded([todo({ dueDate: "2026-12-01" }), todo()]);
    stubMatchMedia(true);
    render(Shell, { props: { user, view: "explore" } });
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("button", { name: "할 일" }).querySelector(".nav-badge")).toBeNull();
  });
});

describe("할 일 tab", () => {
  it("loads, groups by due bucket, and filters with counted chips", async () => {
    const overdue = todo({ title: "지난 보고", dueDate: "2026-10-01" });
    const today = todo({ title: "오늘 리뷰", dueDate: TODAY, priority: "high" });
    const later = todo({ title: "다음달 회고", dueDate: "2026-11-20", tags: ["회고"] });
    const undated = todo({ title: "언젠가 정리", source: "avatar" });
    const done = todo({ title: "끝난 일", status: "done", closedAt: "2026-10-08T00:00:00.000Z" });
    fakeServer([overdue, today, later, undated, done]);
    render(TodosView);

    await screen.findByRole("button", { name: rowName("지난 보고") });
    expect(screen.getByText(/열린 할 일 4개 · 오늘 마감 1개/)).toBeTruthy();
    expect(screen.getByText("· 마감 지남 1개")).toBeTruthy();
    const list = screen.getByRole("region", { name: "할 일 목록" });
    expect(within(list).getByText("8일 지남")).toBeTruthy();
    expect(within(list).getByText("우선순위 높음")).toBeTruthy();
    expect(within(list).getByText("#회고")).toBeTruthy();
    expect(within(list).getByText("아바타").getAttribute("title")).toBe("아바타가 대화에서 추가한 할 일");
    expect(within(list).queryByText("끝난 일")).toBeNull();

    const chips = screen.getByRole("radiogroup", { name: "할 일 필터" });
    expect(within(chips).getAllByRole("radio").map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "오늘 2",
      "예정 1",
      "마감 지남 1",
      "진행 중 0",
      "전체 4",
      "완료 1",
      "드랍 0",
    ]);
    await fireEvent.click(within(chips).getByRole("radio", { name: "완료 1" }));
    expect(within(list).getByText("끝난 일")).toBeTruthy();
    expect(within(list).queryByText("지난 보고")).toBeNull();
    expect(screen.getByRole("button", { name: "완료 항목 비우기" })).toBeTruthy();

    await fireEvent.click(within(chips).getByRole("radio", { name: "오늘 2" }));
    expect(within(list).getByText("지난 보고")).toBeTruthy();
    expect(within(list).getByText("오늘 리뷰")).toBeTruthy();
    expect(within(list).queryByText("다음달 회고")).toBeNull();
  });

  it("adds an item from the form with its optional due date, priority and tags", async () => {
    const server = fakeServer([]);
    render(TodosView);
    await screen.findByText("아직 할 일이 없습니다");
    await fireEvent.input(screen.getByLabelText("새 할 일 제목"), { target: { value: "주간 보고 작성" } });
    await fireEvent.input(screen.getByLabelText("마감일 (선택)"), { target: { value: "2026-10-12" } });
    await fireEvent.change(screen.getByLabelText("우선순위"), { target: { value: "high" } });
    await fireEvent.input(screen.getByLabelText("태그 (선택)"), { target: { value: "보고, #주간" } });
    await fireEvent.submit(screen.getByRole("form", { name: "할 일 추가" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({
      method: "POST",
      body: { title: "주간 보고 작성", priority: "high", dueDate: "2026-10-12", tags: ["보고", "주간"] },
    });
    await screen.findByRole("button", { name: rowName("주간 보고 작성") });
    expect((screen.getByLabelText("새 할 일 제목") as HTMLInputElement).value).toBe("");
  });

  it("completes from the list with a 되돌리기 toast", async () => {
    const item = todo({ title: "메일 회신" });
    const server = fakeServer([item]);
    render(TodosView);
    const box = (await screen.findByRole("checkbox", { name: "완료: 메일 회신" })) as HTMLInputElement;
    await fireEvent.click(box);
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ method: "PATCH", body: { status: "done" } }));
    await waitFor(() => expect(get(toasts).some((toast) => toast.actionLabel === "되돌리기")).toBe(true));
  });

  it("puts in-progress items in 진행 중 on top, tagged, whatever their due date", async () => {
    const overdue = todo({ title: "지난 보고", dueDate: "2026-10-01" });
    const runningLate = todo({ title: "진행 중인 지난 일", dueDate: "2026-10-02", status: "in_progress" });
    const running = todo({ title: "진행 중인 일", status: "in_progress" });
    const later = todo({ title: "다음달 회고", dueDate: "2026-11-20" });
    fakeServer([overdue, runningLate, running, later]);
    render(TodosView);
    await screen.findByRole("button", { name: rowName("지난 보고") });
    expect(screen.getByText(/열린 할 일 4개 · 진행 중 2개 · 오늘 마감 0개/)).toBeTruthy();
    const list = screen.getByRole("region", { name: "할 일 목록" });
    const heads = [...list.querySelectorAll(".routine-group-head span:first-child")].map((head) => head.textContent);
    expect(heads).toEqual(["진행 중", "마감 지남", "예정"]);
    const firstGroup = list.querySelector(".routine-group")!;
    expect(within(firstGroup as HTMLElement).getAllByRole("button").map((row) => row.querySelector(".todo-row-title")?.textContent)).toEqual([
      "진행 중인 지난 일",
      "진행 중인 일",
    ]);
    // Heard with the row (inside its button), and the overdue one keeps its red due chip.
    const lateRow = screen.getByRole("button", { name: rowName("진행 중인 지난 일") });
    expect(lateRow.textContent).toContain("진행 중");
    expect(lateRow.querySelector(".todo-due")?.getAttribute("data-bucket")).toBe("overdue");
    expect(lateRow.closest("li")?.classList.contains("overdue")).toBe(true);

    const chips = screen.getByRole("radiogroup", { name: "할 일 필터" });
    await fireEvent.click(within(chips).getByRole("radio", { name: "진행 중 2" }));
    expect(within(list).queryByText("지난 보고")).toBeNull();
    expect(within(list).getByText("진행 중인 일")).toBeTruthy();
    // The time filters cover open items, in-progress ones included.
    await fireEvent.click(within(chips).getByRole("radio", { name: "마감 지남 2" }));
    expect([...list.querySelectorAll(".routine-group-head span:first-child")].map((head) => head.textContent)).toEqual(["진행 중", "마감 지남"]);
  });

  it("keeps dropped items out of the open lists, in their own 드랍 filter, cleared there after confirmation", async () => {
    const open = todo({ title: "남은 일" });
    const dropped = todo({ title: "안 하기로 한 일", status: "dropped", closedAt: "2026-10-08T00:00:00.000Z", dueDate: "2026-10-01" });
    const done = todo({ title: "끝난 일", status: "done", closedAt: "2026-10-08T01:00:00.000Z" });
    const server = fakeServer([open, dropped, done]);
    render(TodosView);
    await screen.findByRole("button", { name: rowName("남은 일") });
    const list = screen.getByRole("region", { name: "할 일 목록" });
    expect(within(list).queryByText("안 하기로 한 일")).toBeNull();
    expect(screen.queryByText("· 마감 지남 1개")).toBeNull();

    const chips = screen.getByRole("radiogroup", { name: "할 일 필터" });
    await fireEvent.click(within(chips).getByRole("radio", { name: "완료 1" }));
    expect(within(list).queryByText("안 하기로 한 일")).toBeNull();
    expect(screen.queryByRole("button", { name: "드랍 항목 비우기" })).toBeNull();

    await fireEvent.click(within(chips).getByRole("radio", { name: "드랍 1" }));
    const row = within(list).getByText("안 하기로 한 일").closest("li")!;
    expect(row.classList.contains("dropped")).toBe(true);
    expect(row.classList.contains("done")).toBe(false);
    // Closed: no overdue stripe or red chip, and the checkbox (complete) stays empty.
    expect(row.classList.contains("overdue")).toBe(false);
    expect(row.querySelector(".todo-due")?.getAttribute("data-bucket")).toBe("closed");
    expect((within(row as HTMLElement).getByRole("checkbox", { name: "완료: 안 하기로 한 일" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("button", { name: "완료 항목 비우기" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "드랍 항목 비우기" }));
    await waitFor(() => expect(get(confirmation)?.title).toBe("드랍 항목을 비울까요?"));
    resolveConfirmation(true);
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ method: "DELETE", url: "/api/me/todos/dropped" }));
    await screen.findByText("드랍한 할 일이 없습니다");
    expect(server.items.map((item) => item.title).sort()).toEqual(["끝난 일", "남은 일"]);
  });

  it("edits the selected item, and deletes it only after confirmation", async () => {
    const item = todo({ title: "견적서 검토" });
    const server = fakeServer([item]);
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("견적서 검토") }));
    expect(readState().todoSelectedId).toBe(item.id);
    const editor = screen.getByRole("form", { name: "할 일 편집" });
    const save = within(editor).getByRole("button", { name: "저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.input(within(editor).getByLabelText("메모"), { target: { value: "단가 비교표 첨부" } });
    expect(save.disabled).toBe(false);
    await fireEvent.submit(editor);
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ method: "PATCH", body: { note: "단가 비교표 첨부" } }));

    await fireEvent.click(within(editor).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(get(confirmation)?.title).toBe("할 일을 삭제할까요?"));
    resolveConfirmation(true);
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: rowName("견적서 검토") })).toBeNull());
    expect(readState().todoSelectedId).toBe("");
    // The focused editor is gone with the item; focus lands on the add box, not <body>.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("새 할 일 제목")));
  });

  it("names each row by its visible content, so the due date and tags are heard too", async () => {
    fakeServer([todo({ title: "견적서 검토", dueDate: "2026-10-01", tags: ["영업"] })]);
    render(TodosView);
    const row = await screen.findByRole("button", { name: rowName("견적서 검토") });
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(row.textContent).toContain("8일 지남");
    expect(row.textContent).toContain("#영업");
  });
});

describe("할 일 tab editor", () => {
  it("opens the source: a routine's run in 예약 작업, a chat's conversation in 대화", async () => {
    const routine = todo({ title: "루틴이 넣은 일", source: "routine", sourceConversationId: "conv-routine" });
    const chat = todo({ title: "대화에서 넣은 일", source: "avatar", sourceConversationId: "conv-chat" });
    const server = fakeServer([routine, chat]);
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("루틴이 넣은 일") }));
    await fireEvent.click(screen.getByRole("button", { name: "출처 대화 열기" }));
    expect(readState().view).toBe("routines");
    expect(readState().routineConversationId).toBe("conv-routine");

    replaceState({ view: "todos" });
    await fireEvent.click(await screen.findByRole("button", { name: rowName("대화에서 넣은 일") }));
    await fireEvent.click(screen.getByRole("button", { name: "출처 대화 열기" }));
    // The chat branch hands off to selectConversation (which looks the conversation up).
    await waitFor(() => expect(readState().view).toBe("chat"));
    await waitFor(() => expect(server.calls.some((call) => call.url.startsWith("/api/conversations"))).toBe(true));
  });

  it("does not hand a finished save's base to the item the editor moved on to", async () => {
    const first = todo({ title: "첫 항목", note: "A 메모" });
    const second = todo({ title: "둘째 항목", note: "B 메모", priority: "high" });
    const server = fakeServer([first, second]);
    // Hold the first PATCH so the user can move on while it is in flight.
    let release: (() => void) | null = null;
    const fetchFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const real = fetchFn.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<unknown>;
    fetchFn.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      if (init.method === "PATCH" && !release) {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return real(input, init);
    });
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("첫 항목") }));
    let editor = screen.getByRole("form", { name: "할 일 편집" });
    await fireEvent.input(within(editor).getByLabelText("메모"), { target: { value: "A 새 메모" } });
    await fireEvent.submit(editor);
    await waitFor(() => expect(release).not.toBe(null));
    // Still dirty while saving: moving on asks to discard, and the user confirms.
    await fireEvent.click(screen.getByRole("button", { name: rowName("둘째 항목") }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    resolveConfirmation(true);
    await waitFor(() => expect(readState().todoSelectedId).toBe(second.id));
    release!();
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    await flush();
    editor = screen.getByRole("form", { name: "할 일 편집" });
    await fireEvent.input(within(editor).getByLabelText("메모"), { target: { value: "B 새 메모" } });
    await fireEvent.submit(editor);
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    // Only the field the user changed on the SECOND item — nothing diffed against the first.
    expect(server.writes()[1].body).toEqual({ note: "B 새 메모" });
  });

  it("saves only what the user changed, never reverting a field edited elsewhere meanwhile", async () => {
    const item = todo({ title: "견적서 검토", note: "원래 메모" });
    const server = fakeServer([item]);
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("견적서 검토") }));
    const editor = screen.getByRole("form", { name: "할 일 편집" });
    await fireEvent.input(within(editor).getByLabelText("마감일"), { target: { value: "2026-10-20" } });
    // The avatar rewrites the memo (update_todo → tool_end refresh) while the user edits the due date.
    updateState((state) => {
      state.todos = {
        ...state.todos,
        items: state.todos.items.map((t) => (t.id === item.id ? { ...t, note: "아바타가 남긴 메모" } : t)),
      };
    });
    await fireEvent.submit(editor);
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ method: "PATCH", body: { dueDate: "2026-10-20" } });
    expect(server.writes()[0].body).not.toHaveProperty("note");
  });

  it("keeps what the user types while a save is in flight, and saves it next", async () => {
    const item = todo({ title: "견적서 검토", note: "" });
    const server = fakeServer([item]);
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("견적서 검토") }));
    const editor = screen.getByRole("form", { name: "할 일 편집" });
    const memo = within(editor).getByLabelText("메모") as HTMLTextAreaElement;
    await fireEvent.input(memo, { target: { value: "첫 줄" } });
    await fireEvent.submit(editor);
    // Typed before the PATCH answers.
    await fireEvent.input(memo, { target: { value: "첫 줄\n둘째 줄" } });
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    await flush();
    expect(memo.value).toBe("첫 줄\n둘째 줄");
    const save = within(editor).getByRole("button", { name: "저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.submit(editor);
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({ note: "첫 줄\n둘째 줄" });
  });

  it("changes the status at once from its 상태 control — 진행 중, then 드랍 with 되돌리기 — never through 저장", async () => {
    const item = todo({ title: "견적서 검토" });
    const server = fakeServer([item]);
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("견적서 검토") }));
    const editor = screen.getByRole("form", { name: "할 일 편집" });
    // A labelled group of pressed-state buttons (manual activation), not a radiogroup.
    expect(within(editor).queryByRole("radiogroup")).toBeNull();
    const control = within(editor).getByRole("group", { name: "상태" });
    const segments = within(control).getAllByRole("button");
    expect(segments.map((segment) => segment.textContent)).toEqual(["시작 전", "진행 중", "완료", "드랍"]);
    expect(segments.map((segment) => segment.getAttribute("type"))).toEqual(["button", "button", "button", "button"]);
    expect(segments.map((segment) => segment.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(segments.map((segment) => segment.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(within(editor).getByText(/^추가 /)).toBeTruthy();

    await fireEvent.click(within(control).getByRole("button", { name: "진행 중" }));
    await waitFor(() => expect(server.writes()).toEqual([expect.objectContaining({ method: "PATCH", body: { status: "in_progress" } })]));
    await waitFor(() => expect(within(control).getByRole("button", { name: "진행 중" }).getAttribute("aria-pressed")).toBe("true"));
    // Applied outside the form: 저장 never armed.
    expect((within(editor).getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(true);
    const list = screen.getByRole("region", { name: "할 일 목록" });
    expect(list.querySelector(".routine-group-head span")?.textContent).toBe("진행 중");
    // Picking the status it already has writes nothing.
    await fireEvent.click(within(control).getByRole("button", { name: "진행 중" }));
    expect(server.writes()).toHaveLength(1);

    await fireEvent.click(within(control).getByRole("button", { name: "드랍" }));
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ method: "PATCH", body: { status: "dropped" } }));
    const undo = await waitFor(() => {
      const found = get(toasts).find((toast) => toast.message === "할 일을 드랍했습니다 · 견적서 검토");
      expect(found?.actionLabel).toBe("되돌리기");
      return found!;
    });
    // Still selected: the editor shows when it was dropped, though 전체 no longer lists it.
    expect(within(editor).getByText(/^드랍 /)).toBeTruthy();
    expect(within(list).queryByText("견적서 검토")).toBeNull();
    undo.action?.();
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ body: { status: "in_progress" } }));
    await within(list).findByText("견적서 검토");
  });

  it("moves focus with the arrows and Home/End without writing; activating a button applies it, one write at a time", async () => {
    const item = todo({ title: "보고서" });
    const server = fakeServer([item]);
    // Hold PATCHes while `hold` is set, so a second pick lands during the first write.
    let hold = true;
    let release: (() => void) | null = null;
    const fetchFn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const real = fetchFn.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<unknown>;
    fetchFn.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      if (init.method === "PATCH" && hold) await new Promise<void>((resolve) => (release = resolve));
      return real(input, init);
    });
    const patches = () => fetchFn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH").length;
    render(TodosView);
    await fireEvent.click(await screen.findByRole("button", { name: rowName("보고서") }));
    const control = screen.getByRole("group", { name: "상태" });
    const segment = (name: string) => within(control).getByRole("button", { name });
    const pressed = () => within(control).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
    const tabbable = () => within(control).getAllByRole("button").filter((button) => button.tabIndex === 0).map((button) => button.textContent);
    expect(pressed()).toEqual(["시작 전"]);
    expect(tabbable()).toEqual(["시작 전"]);

    // Arrows and Home/End only MOVE focus (and the one tabbable button): nothing is written,
    // toasted or re-sorted on the way, so 시작 전 → 드랍 stays one write.
    segment("시작 전").focus();
    const steps: [string, string][] = [
      ["ArrowRight", "진행 중"],
      ["ArrowDown", "완료"],
      ["End", "드랍"],
      ["ArrowRight", "시작 전"], // wraps
      ["ArrowLeft", "드랍"], // wraps back
      ["Home", "시작 전"],
      ["ArrowUp", "드랍"],
    ];
    for (const [key, lands] of steps) {
      await fireEvent.keyDown(document.activeElement!, { key });
      expect(document.activeElement, `${key} → ${lands}`).toBe(segment(lands));
    }
    expect(tabbable()).toEqual(["드랍"]);
    expect(pressed()).toEqual(["시작 전"]);
    expect(patches()).toBe(0);
    expect(get(toasts)).toEqual([]);
    // Enter and Space are the button's own activation (a click): the key handler leaves them alone.
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      segment("드랍").dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(false);
    }
    expect(patches()).toBe(0);

    // Activating the focused 드랍: one PATCH, applied at once (optimistic).
    await fireEvent.click(segment("드랍"));
    expect(pressed()).toEqual(["드랍"]);
    await waitFor(() => expect(release).not.toBeNull());
    expect(control.getAttribute("aria-busy")).toBe("true");
    // A second pick while that PATCH is in flight is ignored; focus may still move.
    await fireEvent.click(segment("진행 중"));
    await fireEvent.keyDown(segment("드랍"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(segment("완료"));
    expect(patches()).toBe(1);
    expect(pressed()).toEqual(["드랍"]);
    hold = false;
    release!();
    await waitFor(() => expect(control.getAttribute("aria-busy")).toBeNull());
    expect(server.writes()).toEqual([expect.objectContaining({ method: "PATCH", body: { status: "dropped" } })]);
    // The tabbable button stays where focus was last moved (the answer brought no new status)…
    expect(tabbable()).toEqual(["완료"]);
    // …and once settled, the next activation goes through; Tab then lands on the new status.
    await fireEvent.click(segment("진행 중"));
    await waitFor(() => expect(server.writes().at(-1)).toMatchObject({ body: { status: "in_progress" } }));
    await waitFor(() => expect(tabbable()).toEqual(["진행 중"]));
    expect(server.writes()).toHaveLength(2);
  });
});

/**
 * A controllable ResizeObserver: only the to-do card's host (.chat-body) is ever
 * "resized", so the transcript's own observers never see a fake entry.
 */
function stubResizeObserver() {
  const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  return {
    resizeChatBody(width: number) {
      for (const observer of observers) {
        for (const target of observer.targets) {
          if (!target.classList.contains("chat-body")) continue;
          observer.cb([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
        }
      }
    },
  };
}

describe("chat overlay", () => {
  const avatar = {
    id: "owner-1",
    username: "owner",
    displayName: "나",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    isOwn: true,
    elevated: true,
    plugins: [],
  } as unknown as AvatarDetail;

  function seedChat() {
    const pane = {
      id: "pane-1",
      avatar,
      conversationId: "conv-1",
      messages: [],
      draft: "",
      streaming: false,
      liveText: "",
      liveAttachments: [],
      liveStatus: "",
      liveRunId: null,
      liveAgents: [],
      liveTools: [],
      liveTasks: [],
      livePlugins: [],
      groupKnowledgeOff: [],
    } as unknown as ChatPane;
    replaceState({ avatars: [], chatPanes: [pane], activePaneId: "pane-1", view: "chat" });
  }

  function toggle(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".composer-todo-btn")!;
  }

  it("switches on and off from the composer row and remembers the choice per browser", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "지난 일", dueDate: "2026-10-01" }), todo({ title: "오늘 일", dueDate: TODAY })]);
    seedChat();
    render(ChatView);
    const button = toggle();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toContain("할 일 2");
    // Overdue is spelled out in text, not carried by the dot alone.
    expect(button.textContent).toContain("지남 1");
    expect(screen.queryByRole("complementary", { name: "할 일" })).toBeNull();

    await fireEvent.click(button);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBe("true");
    // It lives in the transcript region, so it can never sit over the composer.
    expect(overlay.parentElement?.classList.contains("chat-body")).toBe(true);
    expect(within(overlay).getByRole("region", { name: "마감 지남" })).toBeTruthy();
    expect(within(overlay).getByText("지난 일")).toBeTruthy();
    expect(within(overlay).getByText("오늘 일")).toBeTruthy();

    await fireEvent.click(within(overlay).getByRole("button", { name: "할 일 닫기" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "할 일" })).toBeNull());
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBeNull();
  });

  it("has no add box in the card (adding is the 할 일 tab's form or the avatar)", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "회의록 공유" })]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    expect(within(overlay).queryByRole("textbox")).toBeNull();
    expect(overlay.querySelector("form")).toBeNull();
    expect(within(overlay).getByRole("checkbox", { name: "완료: 회의록 공유" })).toBeTruthy();
  });

  it("hands focus to a transient card on an explicit toggle, and Escape gives it back", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    render(ChatView);
    await fireEvent.click(toggle());
    const card = document.getElementById("todo-overlay")!;
    // jsdom never measures, so the card is a popover: focus moves in after first paint.
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(card.getAttribute("tabindex")).toBe("-1");
    await fireEvent.keyDown(card, { key: "Escape" });
    await waitFor(() => expect(card.hasAttribute("hidden")).toBe(true));
    expect(document.activeElement).toBe(toggle());
    // Focusable only for that moment: a click on its background never takes the caret.
    expect(card.hasAttribute("tabindex")).toBe(false);
  });

  it("leaves focus on the toggle when the card it opened is pinned", async () => {
    const ro = stubResizeObserver();
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    render(ChatView);
    toggle().focus();
    await fireEvent.click(toggle());
    ro.resizeChatBody(1200); // the first measurement, before the deferred focus lands
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await flush();
    const card = document.getElementById("todo-overlay")!;
    expect(card.classList.contains("is-pinned")).toBe(true);
    expect(document.activeElement).toBe(toggle());
    expect(card.hasAttribute("tabindex")).toBe(false);
  });

  it("completes with an undo toast, and the undo reopens the item", async () => {
    const item = todo({ title: "PR 리뷰", dueDate: TODAY });
    const server = fakeServer([item]);
    seedLoaded([item]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    await fireEvent.click(within(overlay).getByRole("checkbox", { name: "완료: PR 리뷰" }));
    await waitFor(() => expect(within(overlay).queryByText("PR 리뷰")).toBeNull());
    const undo = await waitFor(() => {
      const found = get(toasts).find((toast) => toast.actionLabel === "되돌리기");
      expect(found).toBeTruthy();
      return found!;
    });
    undo.action?.();
    await waitFor(() => expect(server.writes().map((call) => call.body)).toEqual([{ status: "done" }, { status: "todo" }]));
    await within(overlay).findByText("PR 리뷰");
  });

  it("shows in-progress items in their own 진행 중 section on top; its checkbox still only completes", async () => {
    const overdue = todo({ title: "지난 일", dueDate: "2026-10-02" });
    const running = todo({ title: "진행 중인 보고", status: "in_progress", dueDate: "2026-10-01" });
    const server = fakeServer([overdue, running]);
    seedLoaded([overdue, running]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    const sections = within(overlay).getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["진행 중", "마감 지남"]);
    expect(within(sections[0]).getByText("진행 중인 보고")).toBeTruthy();
    // The overdue in-progress item sits only in 진행 중, its due date still flagged.
    expect(within(sections[1]).queryByText("진행 중인 보고")).toBeNull();
    expect(sections[0].querySelector(".todo-overlay-due")?.getAttribute("data-bucket")).toBe("overdue");
    // Review and complete only: no status control in the card.
    expect(within(overlay).queryByRole("group", { name: "상태" })).toBeNull();
    await fireEvent.click(within(overlay).getByRole("checkbox", { name: "완료: 진행 중인 보고" }));
    await waitFor(() => expect(server.writes()[0]).toMatchObject({ method: "PATCH", body: { status: "done" } }));
    await waitFor(() => expect(within(overlay).queryByRole("region", { name: "진행 중" })).toBeNull());
  });

  it("starts, pauses and drops a row from its actions; a drop's undo restores the status it had", async () => {
    const item = todo({ title: "배포 점검" });
    const server = fakeServer([item]);
    seedLoaded([item]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    await fireEvent.click(within(overlay).getByRole("button", { name: "진행 중으로: 배포 점검" }));
    await waitFor(() => expect(server.writes().map((call) => call.body)).toEqual([{ status: "in_progress" }]));
    const running = await within(overlay).findByRole("region", { name: "진행 중" });
    expect(within(running).getByText("배포 점검")).toBeTruthy();
    // No toast for a start: the row moving into 진행 중 is the feedback.
    expect(get(toasts).some((toast) => toast.actionLabel === "되돌리기")).toBe(false);
    await fireEvent.click(within(overlay).getByRole("button", { name: "드랍: 배포 점검" }));
    await waitFor(() => expect(within(overlay).queryByText("배포 점검")).toBeNull());
    const undo = await waitFor(() => {
      const found = get(toasts).find((toast) => toast.actionLabel === "되돌리기");
      expect(found?.message).toContain("드랍");
      return found!;
    });
    undo.action?.();
    await waitFor(() =>
      expect(server.writes().map((call) => call.body)).toEqual([{ status: "in_progress" }, { status: "dropped" }, { status: "in_progress" }]),
    );
    await within(overlay).findByRole("button", { name: "시작 전으로: 배포 점검" });
    await fireEvent.click(within(overlay).getByRole("button", { name: "시작 전으로: 배포 점검" }));
    await waitFor(() => expect(server.writes().at(-1)?.body).toEqual({ status: "todo" }));
    await waitFor(() => expect(within(overlay).queryByRole("region", { name: "진행 중" })).toBeNull());
  });

  it("ignores a second action on a row until its write settles", async () => {
    const item = todo({ title: "보고서" });
    const server = fakeServer([item]);
    seedLoaded([item]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    const release = server.holdWrites();
    await fireEvent.click(within(overlay).getByRole("button", { name: "진행 중으로: 보고서" }));
    await fireEvent.click(within(overlay).getByRole("button", { name: "드랍: 보고서" }));
    // The checkbox of the row (re-created in 진행 중) waits for that write too.
    const check = () => within(overlay).getByRole("checkbox", { name: "완료: 보고서" }) as HTMLInputElement;
    expect(check().disabled).toBe(true);
    await fireEvent.click(check());
    expect(server.writes().map((call) => call.body)).toEqual([{ status: "in_progress" }]);
    release();
    await waitFor(() => expect(check().disabled).toBe(false));
    expect(server.writes()).toHaveLength(1);
  });

  it("keeps the keyboard in the card after an action: on the moved row's button, or the next row after a drop", async () => {
    const first = todo({ title: "첫째 일" });
    const second = todo({ title: "둘째 일" });
    fakeServer([first, second]);
    seedLoaded([first, second]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    const start = within(overlay).getByRole("button", { name: "진행 중으로: 첫째 일" });
    start.focus();
    await fireEvent.click(start);
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("시작 전으로: 첫째 일"));
    const dropButton = within(overlay).getByRole("button", { name: "드랍: 첫째 일" });
    dropButton.focus();
    await fireEvent.click(dropButton);
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe("둘째 일"));
    expect(overlay.contains(document.activeElement)).toBe(true);
  });

  it("folds a section to its heading and count, and remembers it per browser", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일 A" }), todo({ title: "다음 일 B" }), todo({ title: "지난 일", dueDate: "2026-10-01" })]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    const view = render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    const heading = within(overlay).getByRole("button", { name: "다음 2" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(heading);
    await waitFor(() => expect(within(overlay).queryByText("다음 일 A")).toBeNull());
    expect(within(overlay).getByRole("button", { name: "다음 2" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(overlay).getByText("지난 일")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("noah.todoOverlayCollapsed") ?? "[]")).toEqual(["next"]);
    view.unmount();
    render(ChatView);
    const again = await screen.findByRole("complementary", { name: "할 일" });
    expect(within(again).getByRole("button", { name: "다음 2" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(again).queryByText("다음 일 A")).toBeNull();
  });

  it("sums up the day in the header; its chips and progress open the tab on that filter", async () => {
    fakeServer([]);
    seedLoaded([
      todo({ title: "끝낸 일", status: "done", closedAt: "2026-10-09T01:00:00.000Z" }),
      todo({ title: "지난 일", dueDate: "2026-10-01" }),
      todo({ title: "오늘 일", dueDate: TODAY, priority: "high", tags: ["보고", "주간"], note: "메모" }),
      todo({ title: "진행 일", status: "in_progress", source: "avatar" }),
    ]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    expect(within(overlay).getByRole("button", { name: "오늘 완료 1 · 남음 2" })).toBeTruthy();
    expect(within(overlay).getByRole("progressbar", { name: "오늘 진척도" }).getAttribute("aria-valuenow")).toBe("1");
    // Only chips with something in them (no 예정 here).
    expect(overlay.querySelectorAll(".todo-overlay-chip")).toHaveLength(2);
    // The row's meta: high priority, the first tag (+N), a memo, the avatar's own addition.
    const row = within(overlay).getByText("오늘 일").closest("li")!;
    expect(within(row).getByRole("img", { name: "우선순위 높음" })).toBeTruthy();
    expect(within(row).getByText("#보고 +1")).toBeTruthy();
    expect(within(row).getByRole("img", { name: "메모 있음" })).toBeTruthy();
    const running = within(overlay).getByText("진행 일").closest("li")!;
    expect(within(running).getByRole("img", { name: "아바타가 대화에서 추가한 할 일" })).toBeTruthy();
    replaceState({ todoSearch: "남은 검색어" });
    await fireEvent.click(within(overlay).getByRole("button", { name: "마감 지남 1개, 할 일 탭에서 보기" }));
    // A leftover search would make the tab disagree with the chip's count.
    expect(readState()).toMatchObject({ view: "todos", todoFilter: "overdue", todoSearch: "" });
  });

  it("minimizes only the pinned card, to its header, and remembers it", async () => {
    const ro = stubResizeObserver();
    fakeServer([]);
    seedLoaded([todo({ title: "지난 일", dueDate: "2026-10-01" })]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    await flush();
    const card = () => document.getElementById("todo-overlay")!;
    // A transient (popover) card has no minimize: it is dismissed instead.
    expect(within(card()).queryByRole("button", { name: "할 일 최소화" })).toBeNull();
    ro.resizeChatBody(1200);
    const minimize = await within(card()).findByRole("button", { name: "할 일 최소화" });
    expect(minimize.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(minimize);
    await waitFor(() => expect(card().classList.contains("is-minimized")).toBe(true));
    expect(minimize.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector<HTMLElement>(".todo-overlay-content")!.hidden).toBe(true);
    expect(card().querySelector(".todo-overlay-counts")?.textContent).toContain("마감 지남 1");
    expect(window.localStorage.getItem("noah.todoOverlayMinimized")).toBe("true");
    await fireEvent.click(minimize);
    await waitFor(() => expect(card().classList.contains("is-minimized")).toBe(false));
    expect(window.localStorage.getItem("noah.todoOverlayMinimized")).toBeNull();
  });

  it("opens the 할 일 tab with the clicked item selected", async () => {
    const item = todo({ title: "예산안 확인" });
    fakeServer([item]);
    seedLoaded([item]);
    seedChat();
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    await fireEvent.click(within(overlay).getByRole("button", { name: "예산안 확인" }));
    expect(readState().view).toBe("todos");
    expect(readState().todoSelectedId).toBe(item.id);
    // jsdom has no layout, so the card is in its transient (popover) form: leaving
    // dismisses it for now and keeps the per-browser preference.
    expect(readState()).toMatchObject({ todoOverlayOpen: true, todoOverlayDismissed: true });
  });

  it("starts a reload's transient card dismissed; only the pinned card shows up on its own", async () => {
    const ro = stubResizeObserver();
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    // A persisted "on" re-opening after a reload — no toggle click.
    replaceState({ todoOverlayOpen: true });
    render(ChatView);
    await flush();
    const card = () => document.getElementById("todo-overlay")!;
    ro.resizeChatBody(700);
    await waitFor(() => expect(card().hasAttribute("hidden")).toBe(true));
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(readState().todoOverlayOpen).toBe(true);
    // The column widens back to pinned: the persistent card returns by itself.
    ro.resizeChatBody(1200);
    await waitFor(() => expect(card().hasAttribute("hidden")).toBe(false));
    expect(card().classList.contains("is-pinned")).toBe(true);
  });

  it("keeps a card the toggle opened, even when the layout measures transient", async () => {
    const ro = stubResizeObserver();
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    render(ChatView);
    await fireEvent.click(toggle());
    await flush();
    ro.resizeChatBody(700);
    await flush();
    expect(document.getElementById("todo-overlay")!.hasAttribute("hidden")).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("in split view presses only the pane that shows the card; another pane's toggle brings it there", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    const [first] = readState().chatPanes;
    replaceState({ chatPanes: [first, { ...first, id: "pane-2", conversationId: "conv-2" }], activePaneId: "pane-1" });
    render(ChatView);
    const toggles = () => [...document.querySelectorAll<HTMLButtonElement>(".composer-todo-btn")];
    await waitFor(() => expect(toggles()).toHaveLength(2));
    await fireEvent.click(toggles()[0]);
    await waitFor(() => expect(toggles()[0].getAttribute("aria-pressed")).toBe("true"));
    expect(toggles()[1].getAttribute("aria-pressed")).toBe("false");
    // Pressing the OTHER pane's toggle moves the card there — it never switches it off.
    await fireEvent.click(toggles()[1]);
    await waitFor(() => expect(readState().activePaneId).toBe("pane-2"));
    expect(readState().todoOverlayOpen).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-pane="pane-2"] #todo-overlay')).not.toBeNull());
    expect(toggles()[1].getAttribute("aria-pressed")).toBe("true");
    expect(toggles()[0].getAttribute("aria-pressed")).toBe("false");
  });

  function seedSplit() {
    seedChat();
    const [first] = readState().chatPanes;
    replaceState({ chatPanes: [first, { ...first, id: "pane-2", conversationId: "conv-2" }], activePaneId: "pane-1" });
  }

  /** A real pointer press: pointerdown, then focus moves (the pane's focusin activates it), then the click. */
  async function pointerPress(button: HTMLButtonElement, beforeClick?: () => void | Promise<void>) {
    await fireEvent.pointerDown(button);
    await fireEvent.focusIn(button);
    await beforeClick?.();
    await fireEvent.click(button);
  }

  it("keeps a fast press in another split pane meaning 'show it here', though focus activates that pane first", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedSplit();
    render(ChatView);
    const toggles = () => [...document.querySelectorAll<HTMLButtonElement>(".composer-todo-btn")];
    await waitFor(() => expect(toggles()).toHaveLength(2));
    await fireEvent.click(toggles()[0]);
    await waitFor(() => expect(toggles()[0].getAttribute("aria-pressed")).toBe("true"));
    await pointerPress(toggles()[1], async () => {
      await waitFor(() => expect(readState().activePaneId).toBe("pane-2"));
    });
    expect(readState().todoOverlayOpen).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-pane="pane-2"] #todo-overlay')).not.toBeNull());
    expect(document.getElementById("todo-overlay")!.hasAttribute("hidden")).toBe(false);
    expect(toggles()[1].getAttribute("aria-pressed")).toBe("true");
    // A second press on the pane that now shows it switches it off.
    await pointerPress(toggles()[1]);
    expect(readState().todoOverlayOpen).toBe(false);
  });

  it("does not hide a card the toggle opened before the remounted card's first measurement", async () => {
    const ro = stubResizeObserver();
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedSplit();
    render(ChatView);
    const toggles = () => [...document.querySelectorAll<HTMLButtonElement>(".composer-todo-btn")];
    await waitFor(() => expect(toggles()).toHaveLength(2));
    await fireEvent.click(toggles()[0]);
    await pointerPress(toggles()[1]);
    await waitFor(() => expect(document.querySelector('[data-pane="pane-2"] #todo-overlay')).not.toBeNull());
    // The click beat the first measure; a narrow split column must not dismiss it now.
    ro.resizeChatBody(500);
    await flush();
    expect(document.getElementById("todo-overlay")!.hasAttribute("hidden")).toBe(false);
  });

  it("leaves Escape to a dialog that has focus", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "다음 일" })]);
    seedChat();
    render(ChatView);
    await fireEvent.click(toggle());
    const card = () => document.getElementById("todo-overlay")!;
    await waitFor(() => expect(card().hasAttribute("hidden")).toBe(false));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    inside.focus();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(card().hasAttribute("hidden")).toBe(false);
    dialog.remove();
    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(card().hasAttribute("hidden")).toBe(true));
  });

  it("dismisses the transient card on Escape and on an outside press — without forgetting the preference", async () => {
    fakeServer([]);
    seedLoaded([todo({ title: "보고서 검토" })]);
    seedChat();
    setTodoOverlayOpen(true);
    render(ChatView);
    const overlay = await screen.findByRole("complementary", { name: "할 일" });
    const title = within(overlay).getByRole("button", { name: "보고서 검토" });
    title.focus(); // moving through the card's items, then Escape
    await fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "할 일" })).toBeNull());
    expect(readState()).toMatchObject({ todoOverlayOpen: true, todoOverlayDismissed: true });
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBe("true");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(toggle());

    // Pressing the toggle shows the card again (the preference was never off).
    await fireEvent.click(toggle());
    await screen.findByRole("complementary", { name: "할 일" });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await fireEvent.pointerDown(toggle());
    await flush();
    expect(readState().todoOverlayDismissed).toBe(false);
    await fireEvent.pointerDown(document.querySelector(".transcript")!);
    await waitFor(() => expect(readState().todoOverlayDismissed).toBe(true));
    expect(window.localStorage.getItem("noah.todoOverlayOpen")).toBe("true");
  });

  it("answers Escape pressed in the composer, but not mid-IME or after another handler took it", async () => {
    fakeServer([]);
    seedLoaded([todo()]);
    seedChat();
    setTodoOverlayOpen(true);
    render(ChatView);
    await screen.findByRole("complementary", { name: "할 일" });
    const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    composer.focus();
    await fireEvent.keyDown(composer, { key: "Escape", isComposing: true });
    await fireEvent.keyDown(composer, { key: "Escape", keyCode: 229 });
    const claimed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    claimed.preventDefault(); // e.g. the slash menu closing itself
    composer.dispatchEvent(claimed);
    await flush();
    expect(readState().todoOverlayDismissed).toBe(false);
    await fireEvent.keyDown(composer, { key: "Escape" });
    await waitFor(() => expect(readState().todoOverlayDismissed).toBe(true));
    // The caret stays in the composer: focus only returns to the toggle from inside the card.
    expect(document.activeElement).toBe(composer);
  });

  it("only suggests asking the avatar where it can actually add to the list", async () => {
    fakeServer([]);
    seedLoaded([]);
    seedChat();
    setTodoOverlayOpen(true);
    const { unmount } = render(ChatView);
    const own = await screen.findByRole("complementary", { name: "할 일" });
    expect(own.textContent).toContain("/todo");
    expect(own.textContent).toContain("할 일 탭");
    unmount();

    // A colleague's avatar has no to-do tools: the 할 일 tab is the way to add.
    replaceState({ chatPanes: readState().chatPanes.map((pane) => ({ ...pane, avatar: { ...pane.avatar, id: "colleague-9" } })) });
    render(ChatView);
    const other = await screen.findByRole("complementary", { name: "할 일" });
    expect(other.textContent).toContain("할 일 탭");
    expect(other.textContent).not.toContain("/todo");
    expect(other.textContent).not.toContain("아바타");
  });

  describe("motion for the avatar's changes", () => {
    let toolSeq = 0;
    /** An avatar's to-do tool finishing in the run stream (the re-read follows). */
    async function avatarTool(name: string) {
      const id = `tu-${(toolSeq += 1)}`;
      noteTodoToolStart(id, name);
      noteTodoToolEnd(id, true);
      await loadTodos();
      await flush();
    }

    function row(overlay: HTMLElement, title: string): HTMLLIElement | null {
      return within(overlay).queryByText(title)?.closest("li") ?? null;
    }

    it("raises the rows the avatar adds, staggered, and pops the composer count — never a poll's", async () => {
      const first = todo({ title: "기존 일" });
      const server = fakeServer([first]);
      seedLoaded([first]);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      expect(row(overlay, "기존 일")?.hasAttribute("data-arrival")).toBe(false);
      expect(document.querySelector(".composer-todo-count.is-popping")).toBeNull();

      server.setItems([
        first,
        todo({ title: "아바타 일 1", dueDate: "2026-10-01", source: "avatar" }),
        todo({ title: "아바타 일 2", dueDate: "2026-10-02", source: "avatar" }),
      ]);
      await avatarTool("mcp__todo__add_todos");
      const added = await waitFor(() => {
        const found = row(overlay, "아바타 일 2");
        expect(found).not.toBeNull();
        return found!;
      });
      expect(row(overlay, "아바타 일 1")?.dataset.arrival).toBe("added");
      expect(row(overlay, "아바타 일 1")?.style.getPropertyValue("--todo-arrival-delay")).toBe("0ms");
      expect(added.dataset.arrival).toBe("added");
      expect(added.style.getPropertyValue("--todo-arrival-delay")).toBe("40ms");
      expect(row(overlay, "기존 일")?.hasAttribute("data-arrival")).toBe(false);
      const count = document.querySelector(".composer-todo-count.is-popping");
      expect(count?.textContent).toBe("3");

      // Someone else's change arriving with the 60 s poll stays still.
      server.setItems([...server.items, todo({ title: "폴링으로 온 일" })]);
      await loadTodos();
      await flush();
      expect(row(overlay, "폴링으로 온 일")?.hasAttribute("data-arrival")).toBe(false);
    });

    it("washes a row the avatar edits in place", async () => {
      const item = todo({ title: "견적서" });
      const server = fakeServer([item]);
      seedLoaded([item]);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      server.setItems([{ ...item, title: "견적서 v2", updatedAt: "2026-10-09T04:00:00.000Z" }]);
      await avatarTool("mcp__todo__update_todo");
      await waitFor(() => expect(row(overlay, "견적서 v2")?.dataset.arrival).toBe("changed"));
    });

    it("slides out a row the avatar deletes, but the viewer's own completion leaves at once", async () => {
      const keep = todo({ title: "남는 일" });
      const doomed = todo({ title: "지울 일" });
      const mine = todo({ title: "내가 끝낼 일" });
      const server = fakeServer([keep, doomed, mine]);
      seedLoaded([keep, doomed, mine]);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      const doomedRow = row(overlay, "지울 일")!;
      const mineRow = row(overlay, "내가 끝낼 일")!;
      const animate = vi.spyOn(Element.prototype, "animate");
      const slidOut = (element: Element) =>
        animate.mock.calls.some(
          (call, index) => animate.mock.contexts[index] === element && (call[1] as KeyframeAnimationOptions | undefined)?.duration === 200,
        );

      server.setItems([keep, mine]);
      await avatarTool("mcp__todo__delete_todo");
      await waitFor(() => expect(row(overlay, "지울 일")).toBeNull());
      expect(slidOut(doomedRow)).toBe(true);

      await fireEvent.click(within(overlay).getByRole("checkbox", { name: "완료: 내가 끝낼 일" }));
      await waitFor(() => expect(row(overlay, "내가 끝낼 일")).toBeNull());
      expect(slidOut(mineRow)).toBe(false);
      expect(row(overlay, "남는 일")).not.toBeNull();
    });

    it("pops the footer's count when the avatar's addition falls past the visible rows", async () => {
      const seeded = Array.from({ length: 8 }, (_, i) => todo({ title: `마감 일 ${i}`, dueDate: "2026-10-01" }));
      const server = fakeServer(seeded);
      seedLoaded(seeded);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      expect(overlay.querySelector(".todo-overlay-more")).toBeNull();
      server.setItems([...seeded, todo({ title: "언젠가 할 일", source: "avatar" })]);
      await avatarTool("mcp__todo__add_todos");
      await waitFor(() => expect(overlay.querySelector(".todo-overlay-more.is-popping")?.textContent).toBe("(외 1개)"));
      expect(within(overlay).getByRole("button", { name: /전체 보기/ }).textContent).toBe("전체 보기 (외 1개) →");
    });

    /** `Element.animate` calls on `element` that ran for `duration` ms (Svelte drives transitions through it). */
    function animatedFor(animate: { mock: { calls: unknown[][]; contexts: unknown[] } }, element: Element | null, duration: number): boolean {
      return animate.mock.calls.some(
        (call, index) => animate.mock.contexts[index] === element && (call[1] as KeyframeAnimationOptions | undefined)?.duration === duration,
      );
    }

    it("fades in the row the avatar's exit brings into view — never one the viewer's own exit does", async () => {
      const visible = Array.from({ length: 8 }, (_, i) => todo({ title: `마감 일 ${i}`, dueDate: "2026-10-01" }));
      const ninth = todo({ title: "아홉째 일" });
      const tenth = todo({ title: "열째 일" });
      const server = fakeServer([...visible, ninth, tenth]);
      seedLoaded([...visible, ninth, tenth]);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      expect(row(overlay, "아홉째 일")).toBeNull();
      const animate = vi.spyOn(Element.prototype, "animate");

      server.setItems(server.items.map((item) => (item.id === visible[0].id ? { ...item, status: "done" as const } : item)));
      await avatarTool("mcp__todo__update_todo");
      const entered = await waitFor(() => {
        const found = row(overlay, "아홉째 일");
        expect(found).not.toBeNull();
        return found!;
      });
      // Not one the avatar added (no rise of its own): it fades in behind the glide.
      expect(entered.hasAttribute("data-arrival")).toBe(false);
      expect(animatedFor(animate, entered, 160)).toBe(true);

      await fireEvent.click(within(overlay).getByRole("checkbox", { name: "완료: 마감 일 1" }));
      const next = await waitFor(() => {
        const found = row(overlay, "열째 일");
        expect(found).not.toBeNull();
        return found!;
      });
      expect(animatedFor(animate, next, 160)).toBe(false);
    });

    it("makes the avatar's exit instant under reduced motion", async () => {
      stubMatchMedia(true); // every query matches: reduced motion (and the phone sheet)
      const keep = todo({ title: "남는 일" });
      const doomed = todo({ title: "지울 일" });
      const server = fakeServer([keep, doomed]);
      seedLoaded([keep, doomed]);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      const doomedRow = row(overlay, "지울 일")!;
      const animate = vi.spyOn(Element.prototype, "animate");
      server.setItems([keep]);
      await avatarTool("mcp__todo__delete_todo");
      await waitFor(() => expect(row(overlay, "지울 일")).toBeNull());
      expect(animate.mock.contexts.includes(doomedRow)).toBe(false);
    });

    it("never re-measures the rows for state writes that leave the list alone (each streamed token)", async () => {
      const items = [todo({ title: "첫째" }), todo({ title: "둘째" })];
      const server = fakeServer(items);
      seedLoaded(items);
      seedChat();
      setTodoOverlayOpen(true);
      render(ChatView);
      const overlay = await screen.findByRole("complementary", { name: "할 일" });
      await flush();
      const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
      const rowMeasures = () =>
        measure.mock.contexts.filter((element) => overlay.contains(element as Node) && (element as Element).matches("li, section")).length;
      updateState((state) => {
        state.chatPanes = state.chatPanes.map((pane) => ({ ...pane, liveText: `${pane.liveText}토큰` }));
      });
      await flush();
      expect(rowMeasures()).toBe(0);
      // A real change of the list does reconcile (and so measure) them.
      server.setItems([...items, todo({ title: "셋째" })]);
      await loadTodos();
      await flush();
      expect(rowMeasures()).toBeGreaterThan(0);
    });
  });
});
