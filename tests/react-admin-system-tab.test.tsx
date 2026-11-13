// Regression pins for the 관리자 → 시스템 tab's local-state seeding (load()'s
// panelsSeeded latch + dirty-guards in AdminView.tsx):
// 1. The FIRST load must seed the panels even though the dirty flags read as
//    "dirty" (empty local state vs fresh server payload) when load()'s
//    continuation reads them — the f168116 guards skipped that first seed,
//    leaving hexPolicy = {} so the tab crashed blank on
//    hexPolicy[role.key][tool.name].
// 2. A manual 새로고침 must still preserve unsaved edits (f168116's intent).
// 3. pi-gateway's models are READ-ONLY here (the model override and vision
//    policy are retired; pi-gateway's admin page owns them).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminView from "../src/client/src/views/AdminView";

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
    {
      id: "deepseek/v3",
      server: "vllm-a",
      default: true,
      imageInput: true,
      reasoning: { efforts: ["low", "high"], defaultEffort: "high" },
    },
    { id: "qwen/coder", server: null, imageInput: false, reasoning: null },
    { id: "older-pi", server: null },
  ],
  observedModel: null,
  confluenceConfigured: false,
  hexSshTools: [
    { name: "ssh-read-lines", label: "원격 파일 읽기", category: "read" },
    { name: "remote-ssh", label: "원격 명령 실행", category: "execute" },
  ],
  hexSshToolPolicy: {
    owner: ["ssh-read-lines", "remote-ssh"],
    trusted: ["ssh-read-lines"],
  },
  toolSkillPolicy: { disabledSkills: [] },
  skillDiscovery: { fetchedAt: "2026-10-29T00:00:00.000Z", skills: [{ name: "pptx", description: "덱 만들기" }] },
  signupMode: "approval",
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
      return json({});
    }),
  );
}

async function openSystemTab(): Promise<void> {
  render(<AdminView />);
  const sysTab = await screen.findByRole("tab", { name: "시스템" });
  fireEvent.click(sysTab);
  await screen.findByText("시스템 정보");
}

describe("admin 시스템 tab: 공지 card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts from the saved notice and saves a changed draft as one paragraph", async () => {
    stubAdminFetch({
      notice: { id: "n-1", text: "금요일 점검", level: "warn", enabled: true, updatedAt: "2026-11-13T00:00:00.000Z" },
    });
    await openSystemTab();

    const text = screen.getByLabelText(/공지 내용/) as HTMLTextAreaElement;
    expect(text.value).toBe("금요일 점검");
    expect(screen.getByRole("radio", { name: "주의" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("팀원 화면에 표시") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("지금 모든 팀원의 화면 위쪽에 표시되고 있습니다.")).toBeTruthy();
    // Nothing changed yet: nothing to save.
    const save = screen.getByRole("button", { name: "공지 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The draft is previewed with the real bar (no close button there).
    expect(screen.getByRole("complementary", { name: "공지 미리 보기" }).textContent).toContain("금요일 점검");

    fireEvent.change(text, { target: { value: "  토요일\n점검  " } });
    fireEvent.click(screen.getByRole("radio", { name: "긴급" }));
    expect(screen.getByText("저장하지 않은 변경 사항이 있습니다.")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "공지 미리 보기" }).classList.contains("level-urgent")).toBe(true);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/admin/notice") && c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.url.includes("/api/admin/notice"))!;
    expect(JSON.parse(put.body || "{}")).toEqual({ text: "토요일 점검", level: "urgent", enabled: true });
  });

  it("with no notice saved starts hidden and empty, and will not show an empty notice", async () => {
    stubAdminFetch({ notice: null });
    await openSystemTab();

    expect((screen.getByLabelText(/공지 내용/) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "안내" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("지금 표시 중인 공지가 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "공지 미리 보기" })).toBeNull();

    fireEvent.click(screen.getByLabelText("팀원 화면에 표시"));
    expect(screen.getByText("표시하려면 공지 내용을 입력해 주세요.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "공지 저장" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("admin 시스템 tab seeding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubAdminFetch();
  });

  it("seeds the panels on first load: tab renders, saved policy shown", async () => {
    await openSystemTab();

    // hex policy checkboxes reflect the SAVED policy (not an unseeded matrix).
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("팀원 원격 명령 실행") as HTMLInputElement).checked).toBe(false);
    // One team: just 소유자 / 팀원 — the 일반 동료 column is retired.
    expect(screen.queryByLabelText("일반 동료 원격 파일 읽기")).toBeNull();
    // Issue #78: no built-in tool toggles; the panel points at pi's admin tool page.
    expect(screen.queryByRole("group", { name: "내장 도구 비활성화" })).toBeNull();
    expect(screen.getByRole("link", { name: "pi-gateway 관리 화면" }).getAttribute("href")).toBe("/admin/");
  });

  it("lists pi-gateway's models read-only and links to pi-gateway's admin page", async () => {
    await openSystemTab();
    const table = screen.getByRole("group", { name: "pi-gateway 모델 목록" });
    const cells = [...table.children].map((cell) => (cell.textContent || "").trim());
    expect(cells).toEqual([
      "모델", "기본", "이미지 입력", "추론 단계",
      "deepseek/v3 vllm-a", "기본", "지원", "low, high (기본 high)",
      "qwen/coder", "—", "미지원", "사용 안 함",
      "older-pi", "—", "알 수 없음 (지원으로 처리)", "알 수 없음",
    ]);
    const link = screen.getByRole("link", { name: "pi-gateway 관리 화면 열기" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/admin/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
    // Nothing to set here any more: no model select, no vision selectors, no save call.
    expect(document.querySelector('select[name="model"]')).toBeNull();
    expect(screen.queryByLabelText("qwen/coder 이미지 입력 지원")).toBeNull();
    const text = document.body.textContent || "";
    expect(text).toContain("배포(docker compose up) 때마다 저장소 기준으로 되돌아갑니다");
    expect(text).not.toContain("MODEL_VISION");
    expect(calls.some((c) => c.url.includes("/api/admin/model"))).toBe(false);
  });

  it("shows the pi runtime and pi's live model list, and nothing of the retired SDK setup", async () => {
    await openSystemTab();

    expect(screen.getByText("pi-gateway")).toBeTruthy();
    expect(screen.getByText("pi 모델")).toBeTruthy();
    expect(screen.getByTitle("제공: vllm-a").textContent).toBe("deepseek/v3");
    expect(screen.getByText("기본 스킬 플러그인에서 찾은 스킬 1개입니다.")).toBeTruthy();
    const text = document.body.textContent || "";
    for (const retired of ["구독 로그인", "setup-token", "인증 방식", "읽기 전용 도구", "ANTHROPIC", "SDK", "CLI v"]) {
      expect(text).not.toContain(retired);
    }
    // The retired env-pinned model row.
    expect(screen.queryByText("설정된 모델")).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/admin/claude-token"))).toBe(false);
  });

  it("says when there are no models (the local stub)", async () => {
    stubAdminFetch({ agentRuntime: "local", piModels: [] });
    await openSystemTab();
    expect(screen.getByText("로컬 스텁")).toBeTruthy();
    expect(screen.getByText("없음 (로컬 스텁)")).toBeTruthy();
    expect(screen.getByText("로컬 스텁에는 모델이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "pi-gateway 모델 목록" })).toBeNull();
  });

  it("keeps unsaved policy edits across a manual 새로고침", async () => {
    await openSystemTab();

    const teammateExec = screen.getByLabelText("팀원 원격 명령 실행") as HTMLInputElement;
    fireEvent.click(teammateExec);
    expect(teammateExec.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeTruthy());

    expect((screen.getByLabelText("팀원 원격 명령 실행") as HTMLInputElement).checked).toBe(true);
    // The untouched rows still show server state.
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
  });
});
