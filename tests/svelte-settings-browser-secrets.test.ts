// 설정 → 권한·연결 → 시크릿: the per-secret 브라우저 입력 control.
//
// The allowed sites ARE the security policy for typing a stored credential into
// the owner's own browser, so the control deliberately is NOT a one-click
// toggle: checking the box opens an inline editor and only 저장 sends the PATCH.
// These pins cover the four things that would quietly weaken that — the request
// body, the reserved-name exclusion, the server's validation text reaching the
// user, and the summary that tells them what is currently allowed.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsAccessTab from "../src/client/src/components/SettingsAccessTab.svelte";
import { appState, readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import type { BrowserSecretPolicy } from "../src/server/secretPolicy.js";
import type { User } from "../src/client/src/lib/types.js";

const BASE_USER = {
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
  secretNames: ["LOGIN_PW", "SSH_PRIVATE_KEY"],
  shellExposedSecretNames: [],
  browserSecrets: [] as BrowserSecretPolicy[],
  sshPublicKey: null,
  groups: [],
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

const PRISTINE = structuredClone(readState());

function userWith(browserSecrets: BrowserSecretPolicy[]): User {
  return { ...BASE_USER, browserSecrets };
}

interface Call {
  url: string;
  method: string;
  body: any;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `patch` decides what PATCH /api/me/secrets/:name answers. Everything else is
 * the tab's own boot chatter (/api/browser-extension), which is best-effort.
 */
function stubFetch(patch: (call: Call) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      const call: Call = {
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (url.startsWith("/api/me/secrets/")) return patch(call);
      if (url.startsWith("/api/browser-extension"))
        return json({ extensionId: null, origins: [], defaultAllowedOrigins: [] });
      return json({});
    }),
  );
}

/** The PATCH bodies the tab sent for one secret. */
function patchesFor(name: string): any[] {
  return calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/${name}`)).map((c) => c.body);
}

function toastMessages(): string[] {
  let seen: string[] = [];
  toasts.subscribe((items) => (seen = items.map((item) => item.message)))();
  return seen;
}

/** The row for one secret — the 브라우저 입력 controls live inside it. */
function rowFor(container: HTMLElement, name: string): HTMLElement {
  const code = [...container.querySelectorAll("code")].find((el) => el.textContent === name);
  const row = code?.closest(".secret-row, .secret-preset-row");
  if (!row) throw new Error(`no row for ${name}`);
  return row as HTMLElement;
}

function browserCheckbox(row: HTMLElement): HTMLInputElement {
  const label = [...row.querySelectorAll("label")].find((el) =>
    el.textContent?.includes("브라우저 입력"),
  );
  const input = label?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error("no 브라우저 입력 checkbox in this row");
  return input as HTMLInputElement;
}

function buttonIn(row: HTMLElement, label: string): HTMLButtonElement {
  const button = [...row.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!button) throw new Error(`no "${label}" button in this row`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("시크릿 카드: 브라우저 입력", () => {
  it("checking the box opens the editor and only 저장 sends the policy", async () => {
    replaceState({ user: userWith([]) });
    const saved: BrowserSecretPolicy = {
      name: "LOGIN_PW",
      hosts: ["jira.corp.com", "login.corp.com"],
      passwordOnly: true,
    };
    stubFetch(() => json({ user: userWith([saved]) }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    const row = rowFor(container, "LOGIN_PW");

    // Ticking the box must NOT save anything yet — there are no allowed sites.
    await fireEvent.click(browserCheckbox(row));
    expect(patchesFor("LOGIN_PW")).toEqual([]);

    const hosts = row.querySelector(".browser-input-hosts input") as HTMLInputElement;
    expect(hosts).toBeTruthy();
    // Password-only is the default the editor opens with.
    const passwordOnly = [...row.querySelectorAll('input[type="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes("비밀번호 필드에만 입력"),
    ) as HTMLInputElement;
    expect(passwordOnly.checked).toBe(true);

    // Commas, spaces and newlines all separate; the server owns validation.
    await fireEvent.input(hosts, { target: { value: "jira.corp.com, login.corp.com" } });
    await fireEvent.click(buttonIn(row, "저장"));

    await waitFor(() => expect(patchesFor("LOGIN_PW").length).toBe(1));
    expect(patchesFor("LOGIN_PW")[0]).toEqual({
      browser: { enabled: true, hosts: ["jira.corp.com", "login.corp.com"], passwordOnly: true },
    });
    await waitFor(() => expect(readState().user?.browserSecrets).toEqual([saved]));
  });

  it("drops empty entries so a trailing comma or newline still sends a clean list", async () => {
    replaceState({ user: userWith([]) });
    // The stub never reports the policy back, so each save closes the editor and
    // leaves the row un-enabled — ready to reopen for the next input.
    stubFetch(() => json({ user: userWith([]) }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    const row = rowFor(container, "LOGIN_PW");

    // `normalizeBrowserSecretHosts` is all-or-nothing over EVERY array entry, and
    // "" is an INVALID entry, not a skipped one — so a trailing comma (the common
    // typing pattern) would 400 the whole save with a message naming a rule the
    // field appears to satisfy. An empty entry carries no intent, so it is dropped
    // here. Nothing ELSE about a host is judged client-side: syntax, the 20-host
    // cap and dedup all stay server-side, which is what keeps all-or-nothing
    // meaningful.
    const cases: [string, string[]][] = [
      ["jira.corp.com, ", ["jira.corp.com"]],
      ["jira.corp.com\n", ["jira.corp.com"]],
      [" ,jira.corp.com,\n login.corp.com , \n", ["jira.corp.com", "login.corp.com"]],
    ];

    for (const [typed, expected] of cases) {
      const before = patchesFor("LOGIN_PW").length;
      await fireEvent.click(browserCheckbox(row));
      const hosts = row.querySelector(".browser-input-hosts input") as HTMLInputElement;
      await fireEvent.input(hosts, { target: { value: typed } });
      await fireEvent.click(buttonIn(row, "저장"));

      await waitFor(() => expect(patchesFor("LOGIN_PW").length).toBe(before + 1));
      expect(patchesFor("LOGIN_PW")[before].browser.hosts, JSON.stringify(typed)).toEqual(expected);
      await waitFor(() => expect(row.querySelector(".browser-input-hosts input")).toBeNull());
    }
  });

  it("unticking a never-enabled secret just cancels — no PATCH, no toast", async () => {
    replaceState({ user: userWith([]) });
    stubFetch(() => json({ user: userWith([]) }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    const row = rowFor(container, "LOGIN_PW");

    // Ticking only OPENS the editor, so unticking it is the same gesture as 취소.
    await fireEvent.click(browserCheckbox(row));
    expect(row.querySelector(".browser-input-hosts input")).toBeTruthy();
    await fireEvent.click(browserCheckbox(row));

    await waitFor(() => expect(row.querySelector(".browser-input-hosts input")).toBeNull());
    // Nothing was on, so nothing may be turned off — and nothing may claim it was.
    expect(patchesFor("LOGIN_PW")).toEqual([]);
    expect(toastMessages()).toEqual([]);
    expect(browserCheckbox(row).checked).toBe(false);
  });

  it("renders the enabled state as a summary of hosts and field scope", async () => {
    replaceState({
      user: userWith([{ name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true }]),
    });
    stubFetch(() => json({ user: readState().user }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    const row = rowFor(container, "LOGIN_PW");

    expect(browserCheckbox(row).checked).toBe(true);
    expect(row.textContent).toContain("브라우저 입력: jira.corp.com · 비밀번호 필드만");
    // 편집 reopens the editor pre-filled with what is stored.
    await fireEvent.click(buttonIn(row, "편집"));
    const hosts = row.querySelector(".browser-input-hosts input") as HTMLInputElement;
    expect(hosts.value).toBe("jira.corp.com");
  });

  it("says 모든 입력 필드 when the password-only restriction is off", () => {
    replaceState({
      user: userWith([
        { name: "LOGIN_PW", hosts: ["jira.corp.com", "sso.corp.com"], passwordOnly: false },
      ]),
    });
    stubFetch(() => json({ user: readState().user }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    expect(rowFor(container, "LOGIN_PW").textContent).toContain(
      "브라우저 입력: jira.corp.com, sso.corp.com · 모든 입력 필드",
    );
  });

  it("unchecking an enabled secret disables it in one PATCH", async () => {
    replaceState({
      user: userWith([{ name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true }]),
    });
    stubFetch(() => json({ user: userWith([]) }));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    await fireEvent.click(browserCheckbox(rowFor(container, "LOGIN_PW")));

    await waitFor(() => expect(patchesFor("LOGIN_PW").length).toBe(1));
    expect(patchesFor("LOGIN_PW")[0]).toEqual({ browser: { enabled: false } });
    await waitFor(() => expect(readState().user?.browserSecrets).toEqual([]));
  });

  it("surfaces the server's own validation text and keeps the editor open", async () => {
    replaceState({ user: userWith([]) });
    stubFetch(() =>
      json(
        { error: "브라우저 입력을 켜려면 허용 사이트(호스트)를 1개 이상 올바르게 입력해 주세요. (예: jira.corp.com)" },
        400,
      ),
    );

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    const row = rowFor(container, "LOGIN_PW");
    await fireEvent.click(browserCheckbox(row));
    await fireEvent.click(buttonIn(row, "저장"));

    await waitFor(() => expect(toastMessages().length).toBeGreaterThan(0));
    expect(toastMessages().join("\n")).toContain("허용 사이트(호스트)를 1개 이상");
    // Still open, still holding what the user typed — a refusal is not a reset.
    expect(row.querySelector(".browser-input-hosts input")).toBeTruthy();
    expect(readState().user?.browserSecrets).toEqual([]);
  });

  it("offers no 브라우저 입력 control for a reserved git/SSH name", () => {
    replaceState({ user: userWith([]) });
    stubFetch(() => json({}));

    const { container } = render(SettingsAccessTab, { props: { active: true } });
    // SSH_PRIVATE_KEY is set, so its row exists and shows the value form…
    const row = rowFor(container, "SSH_PRIVATE_KEY");
    expect(row.textContent).toContain("SSH 개인키");
    // …but its material only ever reaches the app-pinned SSH subprocess.
    expect(() => browserCheckbox(row)).toThrow();
    expect(screen.queryByText("브라우저 입력: ")).toBeNull();
  });
});

describe("실험 기능 카드", () => {
  it("is hidden while no feature is in beta (the canvas graduated)", () => {
    // Even a stale stored "canvas" key must not resurrect the card or its toggle.
    replaceState({ user: { ...userWith([]), experimentalFeatures: ["canvas"] } });
    stubFetch(() => json({ user: readState().user }));

    render(SettingsAccessTab, { props: { active: true } });
    expect(screen.queryByRole("heading", { name: "실험 기능" })).toBeNull();
    expect(screen.queryByText("비주얼 캔버스")).toBeNull();
  });
});
