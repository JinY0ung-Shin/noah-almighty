// Craft apps (admin-only beta) in the UI:
// - the composer's MCP tool picker offers a `craft_*` group only to a system
//   admin whose feature is on and whose app the runner reports `ready`; it
//   starts unchecked, a hidden one never counts in "N/M", and a pick persists
//   on the conversation but never into the remembered default;
// - 관리자 → 시스템 carries the Craft 앱 switch (PUT /api/admin/craft-apps).
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminView from "../src/client/src/views/AdminView.svelte";
import ChatView from "../src/client/src/views/ChatView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import { DEFAULT_MCP_TOOL_GROUPS, MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ChatPane, CraftAppsInfo } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: { url: string; method: string; body: string | null }[] = [];
let meCraftApps: CraftAppsInfo | null = null;
let systemPayload: Record<string, unknown> = {};

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      if (url === "/api/me" && method === "GET") return json({ user: readState().user, craftApps: meCraftApps });
      if (url.includes("/api/admin/system")) return json({ system: systemPayload });
      if (url.includes("/api/admin/stats")) return json({ stats: {} });
      if (url.includes("/api/admin/users")) return json({ users: [] });
      if (url.includes("/api/audit")) return json({ audit: [] });
      if (url.includes("/api/admin/groups")) return json({ groups: [] });
      if (url.includes("/api/admin/external-agents")) return json({ agents: [], configError: null, shadowedManagedIds: [] });
      if (url.includes("/api/browser-extension")) return json({ version: "0.7.0", minCompatibleVersion: "0.6.0" });
      return json({ ok: true, avatars: [], conversations: [], messages: [], skills: [] });
    }),
  );
}

const avatar = {
  id: "avatar-1",
  username: "ava",
  displayName: "아바타",
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

function chatPane(mcpToolGroups: string[]): ChatPane {
  return {
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
    mcpToolGroups,
  } as unknown as ChatPane;
}

const ready: CraftAppsInfo = { enabled: true, apps: [{ id: "photocraft", status: "ready" }, { id: "vectorcraft", status: "failed" }] };

function seedChat(opts: { admin: boolean; craftApps: CraftAppsInfo | null; groups?: string[] }): void {
  meCraftApps = opts.craftApps;
  replaceState({
    user: { id: "u1", roles: opts.admin ? ["admin"] : [], mcpToolGroupsDefault: null, allowedMcpToolGroups: null } as any,
    craftApps: opts.craftApps,
    avatars: [],
    chatPanes: [chatPane(opts.groups ?? [...DEFAULT_MCP_TOOL_GROUPS])],
    activePaneId: "pane-1",
    view: "chat",
  });
}

async function openPicker(container: HTMLElement): Promise<HTMLElement> {
  const button = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>("button.composer-tools-btn");
    expect(found).toBeTruthy();
    return found!;
  });
  await fireEvent.click(button);
  return container.querySelector<HTMLElement>(".composer-tools-panel")!;
}

const nonCraftCount = MCP_TOOL_GROUPS.filter((group) => !group.id.startsWith("craft_")).length;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  vi.stubGlobal("chrome", undefined);
  stubFetch();
});

describe("composer craft tool groups", () => {
  it("offers only the ready app's group to an admin, unchecked, and counts only what it shows", async () => {
    seedChat({ admin: true, craftApps: ready });
    const { container } = render(ChatView);
    const panel = await openPicker(container);
    const photo = screen.getByRole("checkbox", { name: /포토크래프트/ }) as HTMLInputElement;
    expect(photo.checked).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /벡터크래프트/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /디자인크래프트/ })).toBeNull();
    expect(panel.querySelectorAll("input[type=checkbox]")).toHaveLength(nonCraftCount + 1);
    const button = container.querySelector("button.composer-tools-btn")!;
    expect(button.textContent).toContain(`/${nonCraftCount + 1}`);
  });

  it("shows no craft group to a non-admin, or while the feature is off", async () => {
    seedChat({ admin: false, craftApps: ready });
    const first = render(ChatView);
    await openPicker(first.container);
    expect(screen.queryByRole("checkbox", { name: /크래프트/ })).toBeNull();
    expect(first.container.querySelector("button.composer-tools-btn")!.textContent).toContain(`${nonCraftCount}/${nonCraftCount}`);
    first.unmount();

    seedChat({ admin: true, craftApps: { ...ready, enabled: false } });
    const second = render(ChatView);
    await openPicker(second.container);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/me")).toBe(true));
    expect(screen.queryByRole("checkbox", { name: /크래프트/ })).toBeNull();
  });

  it("a hidden craft group kept in a saved selection never counts", async () => {
    seedChat({ admin: true, craftApps: null, groups: [...[...DEFAULT_MCP_TOOL_GROUPS], "craft_photocraft"] });
    meCraftApps = null;
    const { container } = render(ChatView);
    await waitFor(() => expect(container.querySelector("button.composer-tools-btn")).toBeTruthy());
    expect(container.querySelector("button.composer-tools-btn")!.textContent).toContain(`${nonCraftCount}/${nonCraftCount}`);
  });

  it("re-reads craftApps when an admin opens the picker, so a runner that came up shows", async () => {
    seedChat({ admin: true, craftApps: null });
    meCraftApps = ready;
    const { container } = render(ChatView);
    await openPicker(container);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /포토크래프트/ })).toBeTruthy());
  });

  it("a pick turns the group on for THIS conversation but not the remembered default", async () => {
    seedChat({ admin: true, craftApps: ready });
    const { container } = render(ChatView);
    await openPicker(container);
    await fireEvent.click(screen.getByRole("checkbox", { name: /포토크래프트/ }));
    expect(readState().chatPanes[0].mcpToolGroups).toContain("craft_photocraft");
    expect(readState().user!.mcpToolGroupsDefault).not.toContain("craft_photocraft");
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/me/chat-defaults")!;
    expect(JSON.parse(put.body!).mcpToolGroups).not.toContain("craft_photocraft");
    expect((screen.getByRole("checkbox", { name: /포토크래프트/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("관리자 → 시스템 Craft 앱 switch", () => {
  async function openSystemTab(): Promise<void> {
    replaceState({ user: { id: "admin", roles: ["admin"] } as any, craftApps: null });
    render(AdminView);
    await fireEvent.click(await screen.findByRole("tab", { name: "시스템" }));
    await screen.findByText("시스템 정보");
  }

  beforeEach(() => {
    systemPayload = {
      readOnlyTools: [],
      hexSshTools: [],
      hexSshToolPolicy: {},
      togglableBuiltinTools: [],
      toolSkillPolicy: { disabledTools: [], disabledSkills: [] },
      modelVisionPolicy: {},
      signupMode: "open",
      craftAppsEnabled: false,
    };
    meCraftApps = { enabled: false, apps: [{ id: "photocraft", status: "ready" }] };
  });

  it("is off by default and toggles through PUT /api/admin/craft-apps", async () => {
    await openSystemTab();
    expect(screen.getByRole("heading", { name: "Craft 앱 (관리자 전용 베타)" })).toBeTruthy();
    expect(screen.getByText(/craft-runner/)).toBeTruthy();
    expect(screen.getByText(/^꺼져 있습니다\./)).toBeTruthy();

    systemPayload = { ...systemPayload, craftAppsEnabled: true };
    meCraftApps = { enabled: true, apps: [{ id: "photocraft", status: "ready" }] };
    await fireEvent.click(screen.getByRole("button", { name: "Craft 앱 켜기" }));
    await waitFor(() => expect(screen.getByText(/^켜져 있습니다\./)).toBeTruthy());
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/admin/craft-apps")!;
    expect(JSON.parse(put.body!)).toEqual({ enabled: true });
    // The composer's view of availability follows the switch.
    await waitFor(() => expect(readState().craftApps?.enabled).toBe(true));
    expect(screen.getByText("앱 상태: 포토크래프트 준비됨")).toBeTruthy();

    systemPayload = { ...systemPayload, craftAppsEnabled: false };
    await fireEvent.click(screen.getByRole("button", { name: "Craft 앱 끄기" }));
    await waitFor(() => expect(screen.getByText(/^꺼져 있습니다\./)).toBeTruthy());
    expect(JSON.parse(calls.filter((call) => call.method === "PUT").at(-1)!.body!)).toEqual({ enabled: false });
  });
});
