// Regression pins for the 관리자 → 시스템 tab's local-state seeding (load()'s
// panelsSeeded latch + dirty-guards in AdminView.svelte):
// 1. The FIRST load must seed the panels even though the reactive dirty flags
//    recompute (empty local state vs fresh server payload → "dirty") before
//    load()'s continuation reads them — the f168116 guards skipped that first
//    seed, leaving hexPolicy = {} so the tab crashed blank on
//    hexPolicy[role.key][tool.name] and the saved model override rendered as
//    an empty input whose save button would DELETE the override.
// 2. A manual 새로고침 must still preserve unsaved edits (f168116's intent).
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminView from "../src/client/src/views/AdminView.svelte";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mirrors the real deployment shape: HEX_SSH_TOOL_INFOS is always non-empty
// and DEFAULT_HEX_SSH_TOOL_POLICY allows tools, so on first load the saved
// policy key never matches the unseeded (empty) checkbox matrix.
const system = {
  agentRuntime: "claude",
  configuredModel: "claude-opus-4-8",
  modelOverride: "claude-opus-4-8",
  observedModel: null,
  authMode: "api_key",
  readOnlyTools: [],
  confluenceConfigured: false,
  subscriptionConnected: false,
  apiKeyOverride: false,
  modelEnvLocked: false,
  visionDefault: true,
  modelVisionPolicy: {},
  hexSshTools: [
    { name: "ssh-read-lines", label: "원격 파일 읽기", category: "read" },
    { name: "remote-ssh", label: "원격 명령 실행", category: "execute" },
  ],
  hexSshToolPolicy: {
    owner: ["ssh-read-lines", "remote-ssh"],
    trusted: ["ssh-read-lines"],
    colleague: [],
  },
  togglableBuiltinTools: [],
  toolSkillPolicy: { disabledTools: [], disabledSkills: [] },
  skillDiscovery: null,
  signupMode: "open",
};

let calls: { url: string; method: string; body: string | null }[] = [];
let systemPayload: Record<string, unknown> = system;

function stubAdminFetch(systemOverrides: Record<string, unknown> = {}): void {
  calls = [];
  systemPayload = { ...system, ...systemOverrides };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      if (url.includes("/api/admin/stats")) return json({ stats: {} });
      if (url.includes("/api/admin/system")) return json({ system: systemPayload });
      if (url.includes("/api/admin/users")) return json({ users: [] });
      if (url.includes("/api/audit")) return json({ audit: [] });
      if (url.includes("/api/admin/groups")) return json({ groups: [] });
      if (url.includes("/api/admin/external-agents"))
        return json({ agents: [], configError: null, shadowedManagedIds: [] });
      return json({});
    }),
  );
}

async function openSystemTab(): Promise<void> {
  render(AdminView);
  const sysTab = await screen.findByRole("tab", { name: "시스템" });
  await fireEvent.click(sysTab);
  await screen.findByText("시스템 정보");
}

describe("admin 시스템 tab seeding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubAdminFetch();
  });

  it("seeds the panels on first load: tab renders, saved policy + model shown", async () => {
    await openSystemTab();

    // hex policy checkboxes reflect the SAVED policy (not an unseeded matrix).
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("같은 그룹원 원격 명령 실행") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement).checked).toBe(false);

    // The saved model override seeds the input — an empty input here offers a
    // "기본값 사용" save that would silently delete the stored override.
    const modelInput = screen.getByPlaceholderText("claude-opus-4-8 (비우면 기본값)") as HTMLInputElement;
    expect(modelInput.value).toBe("claude-opus-4-8");
  });

  it("keeps unsaved policy edits across a manual 새로고침", async () => {
    await openSystemTab();

    const colleagueRead = screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement;
    await fireEvent.click(colleagueRead);
    expect(colleagueRead.checked).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeTruthy());

    expect((screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
    // The untouched rows still show server state.
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
  });
});
