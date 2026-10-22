// 설정 → 권한·연결 → 서버 에이전트. Pinned: lazy load on the tab, the two
// blocking banners (egress, no SSH key — the latter read LIVE from the vault in
// appState), what a row says (tier, host trust, install status vs the build's
// CLI), client-side validation with the shared validator, the registration
// flow save → host-key fingerprint → trust THAT fingerprint → check, the check
// progress/failure text, the delete dialog's remote-cleanup checkbox, and the
// mount point in the access tab.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsAccessTab from "../src/client/src/components/SettingsAccessTab.svelte";
import SettingsServerAgents from "../src/client/src/components/SettingsServerAgents.svelte";
import { appState, readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import { SERVER_AGENT_ERROR_KO } from "../src/shared/serverAgents.js";
import type { ServerAgentInstallState, ServerAgentListResponse, ServerAgentView, User } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const FP = `SHA256:${"Q".repeat(43)}`;
const AT = "2026-10-22T00:00:00.000Z";

function server(over: Partial<ServerAgentView> = {}): ServerAgentView {
  return {
    id: "s-web",
    name: "web-01",
    host: "web-01.corp.example",
    port: 22,
    username: "noah-agent",
    workdir: "/srv/app",
    role: "주문 API 웹 서버",
    notes: "",
    access: "exec",
    enabled: true,
    installState: { ok: true, version: "0.3.283", error: null, detail: null, checkedAt: AT },
    createdAt: AT,
    updatedAt: AT,
    hostTrusted: true,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: any;
}
type Handler = (call: Call) => Response | Promise<Response>;

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function list(servers: ServerAgentView[], over: Partial<ServerAgentListResponse> = {}): ServerAgentListResponse {
  return { servers, sshKeySet: true, egressBlocked: false, cliVersion: "0.3.283", adminEnabled: true, ...over };
}

/** `routes` maps "METHOD url" → handler; anything else is the access tab's own best-effort chatter. */
function stubFetch(routes: Record<string, Handler>): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      const call: Call = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const handler = routes[`${method} ${url}`];
      if (handler) return handler(call);
      if (url.startsWith("/api/browser-extension")) return json({ extensionId: null, origins: [], defaultAllowedOrigins: [] });
      return json({});
    }),
  );
}

const callsTo = (method: string, url: string): Call[] => calls.filter((call) => call.method === method && call.url === url);
const rowOf = (name: string): HTMLElement => screen.getByText(name, { selector: "strong" }).closest(".server-agent-row") as HTMLElement;

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsServerAgents — loading and banners", () => {
  it("fetches nothing until the tab is opened, then lists; re-entry refetches", async () => {
    stubFetch({ "GET /api/me/server-agents": () => json(list([])) });
    const view = render(SettingsServerAgents, { props: { active: false } });
    expect(calls).toHaveLength(0);
    await view.rerender({ active: true });
    expect(screen.getByRole("heading", { name: "서버 에이전트" }).tagName).toBe("H3");
    await screen.findByText("등록된 서버가 없습니다.");
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    await waitFor(() => expect(callsTo("GET", "/api/me/server-agents")).toHaveLength(2));
  });

  it("warns about blocked egress and a missing SSH key; a key in the vault clears the key banner live", async () => {
    stubFetch({ "GET /api/me/server-agents": () => json(list([], { sshKeySet: false, egressBlocked: true })) });
    render(SettingsServerAgents, { props: { active: true } });
    expect(await screen.findByText(SERVER_AGENT_ERROR_KO.EGRESS_BLOCKED)).toBeTruthy();
    expect(screen.getByText("SSH 키가 없습니다. 위 시크릿 카드에서 SSH 키를 먼저 생성하세요.")).toBeTruthy();
    // The secrets card above writes the vault through appState.
    replaceState({ user: { secretNames: ["SSH_PRIVATE_KEY"] } as unknown as User });
    await waitFor(() => expect(screen.queryByText("SSH 키가 없습니다. 위 시크릿 카드에서 SSH 키를 먼저 생성하세요.")).toBeNull());
  });

  it("until an admin enables the feature, a banner says so and 점검 explains instead of calling", async () => {
    const banner = "관리자가 아직 서버 에이전트 기능을 켜지 않았습니다. 등록과 호스트 신뢰는 할 수 있지만 점검·위임은 관리자가 켠 뒤에 동작합니다.";
    stubFetch({ "GET /api/me/server-agents": () => json(list([server()], { adminEnabled: false })) });
    render(SettingsServerAgents, { props: { active: true } });
    expect(await screen.findByText(banner)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "점검: web-01" }));
    expect(callsTo("POST", "/api/me/server-agents/s-web/check")).toHaveLength(0);
    expect(get(toasts).map((toast) => toast.message)).toContain(banner);
  });
});

describe("SettingsServerAgents — rows", () => {
  it("shows tier, host trust and install status against the build's CLI version", async () => {
    stubFetch({
      "GET /api/me/server-agents": () =>
        json(
          list([
            server(),
            server({ id: "s-old", name: "old-01", access: "read", installState: { ok: true, version: "0.3.200", error: null, detail: null, checkedAt: AT } }),
            server({ id: "s-bad", name: "bad-01", access: "full", installState: { ok: false, version: null, error: "AUTH_FAILED", detail: "x", checkedAt: AT } }),
            server({ id: "s-new", name: "new-01", installState: null, hostTrusted: false, enabled: false }),
          ]),
        ),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await screen.findByText("web-01", { selector: "strong" });

    const web = rowOf("web-01");
    expect(within(web).getByText("noah-agent@web-01.corp.example:22")).toBeTruthy();
    expect(within(web).getByText("명령 실행").className).toContain("tag");
    expect(within(web).getByText("호스트 신뢰됨")).toBeTruthy();
    expect(within(web).getByText("설치됨 0.3.283")).toBeTruthy();
    expect(within(web).queryByRole("button", { name: "호스트 키 확인: web-01" })).toBeNull();

    expect(within(rowOf("old-01")).getByText("업데이트 필요")).toBeTruthy();
    expect(within(rowOf("old-01")).getByText("조회")).toBeTruthy();
    expect(within(rowOf("bad-01")).getByText(`실패: ${SERVER_AGENT_ERROR_KO.AUTH_FAILED}`)).toBeTruthy();
    expect(within(rowOf("bad-01")).getByText("전체")).toBeTruthy();

    const fresh = rowOf("new-01");
    expect(within(fresh).getByText("점검 필요")).toBeTruthy();
    expect(within(fresh).getByText("호스트 미신뢰")).toBeTruthy();
    expect(within(fresh).getByText("꺼짐")).toBeTruthy();
    expect(within(fresh).getByRole("button", { name: "호스트 키 확인: new-01" })).toBeTruthy();
  });
});

describe("SettingsServerAgents — add, trust, check", () => {
  it("validates with the shared validator before any request", async () => {
    stubFetch({ "GET /api/me/server-agents": () => json(list([])) });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "서버 추가" }));
    const form = screen.getByRole("form", { name: "서버 추가" });
    await fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    expect(within(form).getByText("이름을 입력해 주세요.")).toBeTruthy();

    // Required fields are reported before format errors (the shared validator's order).
    await fireEvent.input(within(form).getByLabelText("이름"), { target: { value: "Web_01" } });
    await fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    expect(within(form).getByText("호스트를 입력해 주세요.")).toBeTruthy();

    await fireEvent.input(within(form).getByLabelText("호스트"), { target: { value: "web-01.corp.example" } });
    await fireEvent.input(within(form).getByLabelText("계정"), { target: { value: "noah-agent" } });
    await fireEvent.input(within(form).getByLabelText("작업 디렉터리"), { target: { value: "/srv/app" } });
    await fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    expect(within(form).getByText(/이름 형식이 올바르지 않습니다/)).toBeTruthy();
    expect((within(form).getByLabelText("이름") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");

    await fireEvent.input(within(form).getByLabelText("이름"), { target: { value: "web-01" } });
    await fireEvent.input(within(form).getByLabelText("포트"), { target: { value: "70000" } });
    expect(within(form).getByText(/포트 형식이 올바르지 않습니다/)).toBeTruthy();
    expect((within(form).getByLabelText("이름") as HTMLInputElement).getAttribute("aria-invalid")).toBeNull();
    expect(callsTo("POST", "/api/me/server-agents")).toHaveLength(0);
    // The exec caveat and the unattended-run note sit with the tier picker.
    expect(within(form).getByText(/명령 실행 등급도 셸로 파일을 바꿀 수 있습니다/)).toBeTruthy();
    expect(within(form).getByText("예약 작업·외부 API 실행에도 이 등급이 그대로 적용됩니다.")).toBeTruthy();
  });

  it("registration flow: save → fingerprint → trust THAT fingerprint → automatic first check", async () => {
    const created = server({ installState: null, hostTrusted: false, access: "read", role: "" });
    let finishCheck!: (response: Response) => void;
    stubFetch({
      "GET /api/me/server-agents": () => json(list([])),
      "POST /api/me/server-agents": () => json(created, 201),
      "POST /api/me/server-agents/s-web/host-key": () => json({ fingerprint: FP, keyType: "ssh-ed25519", trusted: false, mismatch: false }),
      "POST /api/me/server-agents/s-web/trust-host": () => json({ server: { ...created, hostTrusted: true }, fingerprint: FP, keyType: "ssh-ed25519", changed: true }),
      "POST /api/me/server-agents/s-web/check": () => new Promise<Response>((resolve) => { finishCheck = resolve; }),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "서버 추가" }));
    const form = screen.getByRole("form", { name: "서버 추가" });
    await fireEvent.input(within(form).getByLabelText("이름"), { target: { value: "web-01" } });
    await fireEvent.input(within(form).getByLabelText("호스트"), { target: { value: "Web-01.corp.example" } });
    await fireEvent.input(within(form).getByLabelText("계정"), { target: { value: "noah-agent" } });
    await fireEvent.input(within(form).getByLabelText("작업 디렉터리"), { target: { value: "/srv/app" } });
    await fireEvent.click(within(form).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(callsTo("POST", "/api/me/server-agents")).toHaveLength(1));
    expect(callsTo("POST", "/api/me/server-agents")[0].body).toMatchObject({
      name: "web-01",
      host: "web-01.corp.example",
      port: 22,
      username: "noah-agent",
      workdir: "/srv/app",
      access: "read",
      enabled: true,
    });
    // The fingerprint is fetched without being asked and shown for reading.
    const panel = await screen.findByRole("group", { name: "호스트 키 확인: web-01" });
    await within(panel).findByText(FP);
    expect(within(panel).getByText("ssh-ed25519")).toBeTruthy();
    expect(callsTo("POST", "/api/me/server-agents/s-web/trust-host")).toHaveLength(0);

    await fireEvent.click(within(panel).getByRole("button", { name: "이 지문을 신뢰" }));
    await waitFor(() => expect(callsTo("POST", "/api/me/server-agents/s-web/trust-host")).toHaveLength(1));
    expect(callsTo("POST", "/api/me/server-agents/s-web/trust-host")[0].body).toEqual({ fingerprint: FP });

    // A never-checked server goes straight on to its first check, with progress text.
    await waitFor(() => expect(callsTo("POST", "/api/me/server-agents/s-web/check")).toHaveLength(1));
    expect(await screen.findByText(/점검 중… 처음에는 에이전트 프로그램\(약 240MB\)을 올리느라/)).toBeTruthy();
    expect(within(rowOf("web-01")).getByText("호스트 신뢰됨")).toBeTruthy();
    const ok: ServerAgentInstallState = { ok: true, version: "0.3.283", error: null, detail: null, checkedAt: AT };
    finishCheck(json(ok));
    await waitFor(() => expect(within(rowOf("web-01")).getByText("설치됨 0.3.283")).toBeTruthy());
  });

  it("warns in red about a mismatched key and keeps the server's 409 text when the key changed meanwhile", async () => {
    stubFetch({
      "GET /api/me/server-agents": () => json(list([server({ hostTrusted: true, installState: { ok: false, version: null, error: "HOST_KEY_MISMATCH", detail: null, checkedAt: AT } })])),
      "POST /api/me/server-agents/s-web/host-key": () => json({ fingerprint: FP, keyType: "ssh-ed25519", trusted: false, mismatch: true }),
      "POST /api/me/server-agents/s-web/trust-host": () => json({ error: "키가 바뀌었습니다." }, 409),
    });
    render(SettingsServerAgents, { props: { active: true } });
    // A host-key error keeps the 호스트 키 확인 action even though known_hosts has an entry.
    await fireEvent.click(await screen.findByRole("button", { name: "호스트 키 확인: web-01" }));
    const panel = await screen.findByRole("group", { name: "호스트 키 확인: web-01" });
    const warning = await within(panel).findByRole("alert");
    expect(warning.textContent).toContain("이미 신뢰된 키와 다른 키입니다");
    expect(warning.className).toContain("server-agent-danger");
    await fireEvent.click(within(panel).getByRole("button", { name: "이 지문을 신뢰" }));
    expect(await within(panel).findByText("키가 바뀌었습니다.")).toBeTruthy();
  });

  it("점검 on an untrusted host opens the trust step first instead of failing", async () => {
    stubFetch({
      "GET /api/me/server-agents": () => json(list([server({ hostTrusted: false, installState: null })])),
      "POST /api/me/server-agents/s-web/host-key": () => json({ fingerprint: FP, keyType: "ssh-ed25519", trusted: false, mismatch: false }),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "점검: web-01" }));
    await screen.findByRole("group", { name: "호스트 키 확인: web-01" });
    expect(callsTo("POST", "/api/me/server-agents/s-web/check")).toHaveLength(0);
    expect(callsTo("POST", "/api/me/server-agents/s-web/host-key")).toHaveLength(1);
  });

  it("a failed check shows the Korean reason on the row", async () => {
    stubFetch({
      "GET /api/me/server-agents": () => json(list([server()])),
      "POST /api/me/server-agents/s-web/check": () =>
        json({ ok: false, version: "0.3.283", error: "TLS_CA", detail: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", checkedAt: AT }),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "점검: web-01" }));
    await waitFor(() => expect(within(rowOf("web-01")).getByText(`실패: ${SERVER_AGENT_ERROR_KO.TLS_CA}`)).toBeTruthy());
  });
});

describe("SettingsServerAgents — edit and delete", () => {
  it("edits in place and PATCHes the normalized value", async () => {
    stubFetch({
      "GET /api/me/server-agents": () => json(list([server()])),
      "PATCH /api/me/server-agents/s-web": (call) => json(server({ ...call.body })),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "수정: web-01" }));
    const form = screen.getByRole("form", { name: "서버 수정: web-01" });
    expect((within(form).getByLabelText("작업 디렉터리") as HTMLInputElement).value).toBe("/srv/app");
    await fireEvent.input(within(form).getByLabelText("역할"), { target: { value: "결제 배치 서버" } });
    await fireEvent.click(within(form).getByLabelText(/전체/));
    await fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/me/server-agents/s-web")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/me/server-agents/s-web")[0].body).toMatchObject({ role: "결제 배치 서버", access: "full", port: 22 });
    await waitFor(() => expect(screen.queryByRole("form", { name: "서버 수정: web-01" })).toBeNull());
    expect(within(rowOf("web-01")).getByText("결제 배치 서버")).toBeTruthy();
    // Same host → no new trust step.
    expect(callsTo("POST", "/api/me/server-agents/s-web/host-key")).toHaveLength(0);
  });

  it("asks before deleting, with remote cleanup on by default and optional", async () => {
    stubFetch({
      "GET /api/me/server-agents": () => json(list([server(), server({ id: "s-db", name: "db-01" })])),
      "DELETE /api/me/server-agents/s-web?cleanupRemote=1": () => json({ ok: true, cleanup: "failed", cleanupError: SERVER_AGENT_ERROR_KO.UNREACHABLE }),
      "DELETE /api/me/server-agents/s-db": () => json({ ok: true, cleanup: "skipped" }),
    });
    render(SettingsServerAgents, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "삭제: web-01" }));
    const dialog = await screen.findByRole("dialog");
    const cleanup = within(dialog).getByLabelText(/서버에 설치된 에이전트 파일도 삭제/) as HTMLInputElement;
    expect(cleanup.checked).toBe(true);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    await fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(screen.queryByText("web-01", { selector: "strong" })).toBeNull());
    expect(callsTo("DELETE", "/api/me/server-agents/s-web?cleanupRemote=1")).toHaveLength(1);
    // A failed remote cleanup still deleted the row — and says so.
    expect(get(toasts).map((toast) => toast.message)).toContain(
      `서버 등록은 삭제했지만 서버의 에이전트 파일은 지우지 못했습니다. ${SERVER_AGENT_ERROR_KO.UNREACHABLE}`,
    );

    await fireEvent.click(screen.getByRole("button", { name: "삭제: db-01" }));
    const second = await screen.findByRole("dialog");
    await fireEvent.click(within(second).getByLabelText(/서버에 설치된 에이전트 파일도 삭제/));
    await fireEvent.click(within(second).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(callsTo("DELETE", "/api/me/server-agents/s-db")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("db-01", { selector: "strong" })).toBeNull());
  });
});

describe("SettingsAccessTab mount", () => {
  it("renders the server-agent card on the access tab", async () => {
    stubFetch({ "GET /api/me/server-agents": () => json(list([])) });
    replaceState({ user: { secretNames: ["SSH_PRIVATE_KEY"], shellExposedSecretNames: [], browserSecrets: [], experimentalFeatures: [], groups: [] } as unknown as User });
    render(SettingsAccessTab, { props: { active: true } });
    expect(await screen.findByRole("heading", { name: "서버 에이전트" })).toBeTruthy();
    await waitFor(() => expect(callsTo("GET", "/api/me/server-agents")).toHaveLength(1));
  });
});
