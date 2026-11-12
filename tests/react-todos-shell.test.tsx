// 할 일 UI, the rail half: the rail entry + its badge (Shell). The detailed tab
// and the chat overlay are covered with their own components' ports. A small
// fake /api/me/todos server stands in for the backend, as in the rest of the
// 할 일 suite.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state";
import { resetTodoClientState } from "../src/client/src/lib/todos";
import type { User } from "../src/client/src/lib/types";
import { isOpenTodo, type TodoCounts, type TodoItem } from "../src/shared/todos";

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
  seenFeatureHints: [],
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

/** A stand-in for routes/todos.ts; anything else answers the empty bodies the rail's mount load expects. */
function fakeServer(initial: TodoItem[]) {
  const items = [...initial];
  const snapshot = () => ({ todayKst: TODAY, counts: countsOf(items) });
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url === "/api/me/todos" && method === "GET") return jsonRes({ todos: items, ...snapshot() });
    return jsonRes({ avatars: [], conversations: [], messages: [], skills: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
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
  // 움직임 줄이기 is the app's own attribute (lib/motion.ts) — never leak it into the next test.
  delete document.documentElement.dataset.motion;
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
    render(<Shell user={user} view="explore" />);
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.querySelector("span")?.textContent);
    expect(labels.indexOf("할 일")).toBe(labels.indexOf("대화") + 1);
    const entry = within(nav).getByRole("button", { name: /할 일/ });
    const badge = entry.querySelector(".nav-badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("title")).toBe("마감 지남 1개 · 오늘 마감 2개");

    fireEvent.click(entry);
    expect(readState().view).toBe("todos");
  });

  it("shows no badge when nothing is overdue or due today", () => {
    fakeServer([]);
    seedLoaded([todo({ dueDate: "2026-12-01" }), todo()]);
    stubMatchMedia(true);
    render(<Shell user={user} view="explore" />);
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByRole("button", { name: "할 일" }).querySelector(".nav-badge")).toBeNull();
  });
});
