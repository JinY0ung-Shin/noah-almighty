// Regression pins for the 관리자 → 시스템 tab's local-state seeding (load()'s
// panelsSeeded latch + dirty-guards in AdminView.svelte):
// 1. The FIRST load must seed the panels even though the reactive dirty flags
//    recompute (empty local state vs fresh server payload → "dirty") before
//    load()'s continuation reads them — the f168116 guards skipped that first
//    seed, leaving hexPolicy = {} so the tab crashed blank on
//    hexPolicy[role.key][tool.name] and the saved model override rendered as
//    an empty select whose save button would DELETE the override.
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
  agentRuntime: "pi",
  piModels: [
    { id: "deepseek/v3", server: "vllm-a" },
    { id: "qwen/coder", server: null },
  ],
  modelOverride: "deepseek/v3",
  modelOverrideIgnored: false,
  modelOverrideChoices: ["deepseek/v3", "qwen/coder"],
  observedModel: null,
  confluenceConfigured: false,
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
  skillDiscovery: { fetchedAt: "2026-10-29T00:00:00.000Z", skills: [{ name: "pptx", description: "덱 만들기" }] },
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

function modelSelect(): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>('select[name="model"]');
  expect(el).toBeTruthy();
  return el!;
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

    // The saved model override seeds the select — an empty value here offers a
    // "기본값 사용" save that would silently delete the stored override.
    expect(modelSelect().value).toBe("deepseek/v3");
    expect([...modelSelect().options].map((o) => o.value)).toEqual(["", "deepseek/v3", "qwen/coder"]);
  });

  it("shows the pi runtime and pi's live model list, and nothing of the retired SDK setup", async () => {
    await openSystemTab();

    expect(screen.getByText("pi-gateway")).toBeTruthy();
    expect(screen.getByText("pi 모델")).toBeTruthy();
    expect(screen.getByTitle("제공: vllm-a").textContent).toBe("deepseek/v3");
    // The per-model vision rows are keyed by pi model id.
    expect(screen.getByLabelText("qwen/coder 이미지 입력 지원")).toBeTruthy();
    expect(screen.getByText("기본 스킬 플러그인에서 찾은 스킬 1개입니다.")).toBeTruthy();
    const text = document.body.textContent || "";
    for (const retired of ["구독 로그인", "setup-token", "인증 방식", "읽기 전용 도구", "ANTHROPIC", "SDK", "CLI v"]) {
      expect(text).not.toContain(retired);
    }
    // The retired env-pinned model row (the vision card's prose also says "설정된 모델").
    expect(screen.queryByText("설정된 모델")).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/admin/claude-token"))).toBe(false);
  });

  it("says when there are no models (the local stub)", async () => {
    stubAdminFetch({ agentRuntime: "local", piModels: [], modelOverride: null, modelOverrideChoices: [] });
    await openSystemTab();
    expect(screen.getByText("로컬 스텁")).toBeTruthy();
    expect(screen.getByText("없음 (로컬 스텁)")).toBeTruthy();
  });

  it("shows a stored override pi no longer offers as ignored, without pretending it is selectable", async () => {
    stubAdminFetch({ modelOverride: "opus", modelOverrideIgnored: true });
    await openSystemTab();
    expect(modelSelect().value).toBe("opus");
    const stale = [...modelSelect().options].find((o) => o.value === "opus")!;
    expect(stale.disabled).toBe(true);
    expect(stale.textContent).toContain("현재 제공되지 않음");
    expect(document.getElementById("admin-model-status")?.textContent).toContain("무시하고 기본 모델을 사용 중");
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
