// The login / signup / first-run screen. (AuthView had no component test before
// the React port; these pin what the port must keep.)
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthView from "../src/client/src/components/AuthView";
import { loginServerNav, restoreLoginReturnHash } from "../src/client/src/lib/loginServer";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { BootstrapInfo } from "../src/client/src/lib/types";

const bootstrapOf = (patch: Partial<BootstrapInfo>): BootstrapInfo => ({ needsSetup: false, signupMode: "closed", ...patch }) as BootstrapInfo;

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// The label's text includes its inline hint, so the fields are found by name.
const usernameInput = () => document.querySelector('input[name="username"]') as HTMLInputElement;

function fill(username: string, password: string): void {
  fireEvent.change(usernameInput(), { target: { value: username } });
  fireEvent.change(document.querySelector('input[name="password"]')!, { target: { value: password } });
}

beforeEach(() => {
  replaceState({ user: null });
  toasts.set([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", location.pathname);
  sessionStorage.clear();
});

describe("AuthView", () => {
  it("opens on the login form, and enables the submit only for a 3+ character name and an 8+ character password", () => {
    render(<AuthView bootstrap={bootstrapOf({ signupMode: "closed" })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("다시 오신 것을 환영합니다");
    const submit = screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement;
    const status = document.getElementById("auth-submit-status")!;
    expect(submit.disabled).toBe(true);
    expect(status.textContent).toBe("사용자명을 입력해 주세요.");
    expect(status.classList.contains("warn")).toBe(true);
    expect(usernameInput().getAttribute("aria-describedby")).toBe("auth-username-issue auth-submit-status");
    expect(usernameInput().getAttribute("aria-invalid")).toBe("true");

    fill("ab", "12345678");
    expect(status.textContent).toBe("사용자명은 3자 이상이어야 합니다.");
    expect(submit.disabled).toBe(true);
    fill("abc", "1234567");
    expect(status.textContent).toBe("비밀번호는 8자 이상이어야 합니다.");
    fill("abc", "12345678");
    expect(status.textContent).toBe("로그인할 준비가 됐습니다.");
    expect(status.classList.contains("warn")).toBe(false);
    expect(usernameInput().getAttribute("aria-describedby")).toBe("auth-submit-status");
    expect(usernameInput().getAttribute("aria-invalid")).toBe("false");
    expect(submit.disabled).toBe(false);
    // Signup is closed: no way to the signup form, and it says so.
    expect(screen.getByText("현재 회원가입을 받지 않습니다.")).toBeTruthy();
    expect(document.querySelector('input[name="displayName"]')).toBeNull();
  });

  it("shows and hides the password without losing what was typed", () => {
    render(<AuthView bootstrap={bootstrapOf({})} />);
    fill("owner", "secret-password");
    const password = document.querySelector('input[name="password"]') as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 보기" }));
    expect(password.type).toBe("text");
    expect(password.value).toBe("secret-password");
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 숨기기" }));
    expect(password.type).toBe("password");
  });

  it("is the admin-setup form on a first run, with no way to the login form — also when the bootstrap arrives later", () => {
    const view = render(<AuthView bootstrap={bootstrapOf({ signupMode: "approval" })} />);
    expect(screen.getByRole("button", { name: "가입 승인 요청" })).toBeTruthy();

    view.rerender(<AuthView bootstrap={bootstrapOf({ needsSetup: true })} />);
    expect(screen.getByText("첫 실행 · 관리자 설정")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("관리자 계정 만들기");
    expect(document.querySelector('input[name="displayName"]')).not.toBeNull();
    expect(document.querySelector(".auth-switch")).toBeNull();
    expect((document.querySelector('input[name="password"]') as HTMLInputElement).autocomplete).toBe("new-password");
    expect(screen.getByRole("button", { name: "관리자 계정 만들기" })).toBeTruthy();
  });

  it("says why the login screen appeared when it was opened from a share link, following the hash", async () => {
    history.replaceState(null, "", `${location.pathname}#/share/abc`);
    render(<AuthView bootstrap={bootstrapOf({})} />);
    const hint = screen.getByRole("note");
    expect(hint.textContent).toBe("공유받은 PPT를 보려면 Noah에 로그인하세요.");
    expect(hint.classList.contains("auth-share-hint")).toBe(true);
    // The scope class its stylesheet keys on.
    expect(hint.closest(".cmp-auth-view")).toBe(document.querySelector("main.auth-view"));

    history.replaceState(null, "", location.pathname);
    act(() => {
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("logs in with the trimmed name and hands the user to the app state", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return jsonRes({ user: { id: "u-1", username: "owner" } });
      }),
    );
    render(<AuthView bootstrap={bootstrapOf({})} />);
    fill("  owner  ", "secret-password");
    fireEvent.submit(document.querySelector("form")!);
    expect((screen.getByRole("button", { name: "로그인 중…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(readState().user?.id).toBe("u-1"));
    expect(calls).toEqual([{ url: "/api/auth/login", body: { username: "owner", password: "secret-password" } }]);
    expect(readState().view).toBe("explore");
    // A plain login announces nothing.
    expect(get(toasts)).toEqual([]);
  });

  it("shows the server's error and lets the form be used again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, 401)));
    render(<AuthView bootstrap={bootstrapOf({})} />);
    fill("owner", "wrong-password");
    fireEvent.submit(document.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
    expect((screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement).disabled).toBe(false);
    expect(readState().user).toBeNull();
  });

  it("sends a signup with the display name, and returns to the login form while it waits for approval", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return jsonRes({ pending: true });
      }),
    );
    render(<AuthView bootstrap={bootstrapOf({ signupMode: "approval" })} />);
    fireEvent.click(screen.getByRole("button", { name: "가입 승인 요청" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Noah Almighty 시작하기");
    expect(screen.getByText("관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.")).toBeTruthy();
    fill("newbie", "secret-password");
    fireEvent.change(document.querySelector('input[name="displayName"]')!, { target: { value: " 새 동료 " } });
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("승인 요청을 보낼 준비가 됐습니다.");
    fireEvent.submit(document.querySelector("form")!);

    const note = await screen.findByText("가입 요청이 승인 대기 상태입니다.");
    expect(note.getAttribute("role")).toBe("status");
    expect(calls).toEqual([
      { url: "/api/auth/signup", body: { username: "newbie", displayName: "새 동료", password: "secret-password" } },
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("다시 오신 것을 환영합니다");
    expect(readState().user).toBeNull();
    expect(get(toasts).map((toast) => toast.message)).toEqual([
      "가입 요청이 접수되었습니다. 관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.",
    ]);
    // Switching the form clears the pending note.
    fireEvent.click(screen.getByRole("button", { name: "가입 승인 요청" }));
    expect(screen.queryByText("가입 요청이 승인 대기 상태입니다.")).toBeNull();
  });
});

// ---- Single sign-on (bootstrap `sso`) ---------------------------------

const passwordInput = () => document.querySelector('input[name="password"]') as HTMLInputElement | null;
const typeUsername = (value: string) => fireEvent.change(usernameInput(), { target: { value } });

type Call = { url: string; body: unknown };

/** Answers each auth path from `routes`; an unlisted path is a test bug. */
function stubAuthFetch(routes: Record<string, () => unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const route = routes[url];
      if (!route) throw new Error(`unexpected request: ${url}`);
      return route();
    }),
  );
  return calls;
}

/** The full-page navigation to the login server, recorded instead of made. */
function watchNavigation(): string[] {
  const visited: string[] = [];
  vi.spyOn(loginServerNav, "assign").mockImplementation((url: string) => {
    visited.push(url);
  });
  return visited;
}

describe("AuthView without single sign-on", () => {
  it("is the built-in form, never asks for the login method, and leaves an ?auth= code alone", async () => {
    history.replaceState(null, "", `${location.pathname}?auth=failed`);
    const visited = watchNavigation();
    const calls = stubAuthFetch({ "/api/auth/login": () => jsonRes({ user: { id: "u-1", username: "owner" } }) });
    render(<AuthView bootstrap={bootstrapOf({ signupMode: "approval", sso: false })} />);

    // Both fields at once, the old signup switch, and no notice for the code.
    expect(passwordInput()).not.toBeNull();
    expect(screen.getByRole("button", { name: "로그인" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다음" })).toBeNull();
    expect(screen.getByRole("button", { name: "가입 승인 요청" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "가입 신청" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(location.search).toBe("?auth=failed");

    fill("owner", "secret-password");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(readState().user?.id).toBe("u-1"));
    expect(calls).toEqual([{ url: "/api/auth/login", body: { username: "owner", password: "secret-password" } }]);
    expect(visited).toEqual([]);
  });

  it("still opens the built-in signup form", () => {
    render(<AuthView bootstrap={bootstrapOf({ signupMode: "approval", sso: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "가입 승인 요청" }));
    expect(document.querySelector('input[name="displayName"]')).not.toBeNull();
    expect(passwordInput()!.autocomplete).toBe("new-password");
  });
});

describe("AuthView with single sign-on", () => {
  const sso = (patch: Partial<BootstrapInfo> = {}) => bootstrapOf({ sso: true, ...patch });

  it("asks for the username first: no password field, and 다음 only for a 3+ character name", () => {
    render(<AuthView bootstrap={sso()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("다시 오신 것을 환영합니다");
    expect(passwordInput()).toBeNull();
    const next = screen.getByRole("button", { name: "다음" }) as HTMLButtonElement;
    const status = document.getElementById("auth-submit-status")!;
    expect(next.disabled).toBe(true);
    expect(status.textContent).toBe("사용자명을 입력해 주세요.");
    expect(status.classList.contains("warn")).toBe(true);
    expect(usernameInput().getAttribute("aria-describedby")).toBe("auth-username-issue auth-submit-status");

    typeUsername("ab");
    expect(status.textContent).toBe("사용자명은 3자 이상이어야 합니다.");
    expect(next.disabled).toBe(true);
    typeUsername("abc");
    expect(status.textContent).toBe("다음 단계로 넘어갈 준비가 됐습니다.");
    expect(status.classList.contains("warn")).toBe(false);
    expect(usernameInput().getAttribute("aria-invalid")).toBe("false");
    expect(next.disabled).toBe(false);
  });

  it("an account with a built-in password gets the password field, and logs in as before", async () => {
    const visited = watchNavigation();
    const calls = stubAuthFetch({
      "/api/auth/login-method": () => jsonRes({ method: "password" }),
      "/api/auth/login": () => jsonRes({ user: { id: "u-1", username: "owner" } }),
    });
    render(<AuthView bootstrap={sso()} />);
    typeUsername("  owner  ");
    fireEvent.submit(document.querySelector("form")!);
    expect((screen.getByRole("button", { name: "확인 중…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("사용자명을 확인하는 중입니다.");
    expect(document.querySelector("form")!.getAttribute("aria-busy")).toBe("true");

    // The field appears with the focus in it; the name stays editable.
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    expect(document.activeElement).toBe(passwordInput());
    expect(passwordInput()!.autocomplete).toBe("current-password");
    expect(usernameInput().disabled).toBe(false);
    const login = screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement;
    expect(login.disabled).toBe(true);
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("비밀번호를 입력해 주세요.");
    fireEvent.change(passwordInput()!, { target: { value: "1234567" } });
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("비밀번호는 8자 이상이어야 합니다.");
    fireEvent.change(passwordInput()!, { target: { value: "secret-password" } });
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("로그인할 준비가 됐습니다.");
    expect(login.disabled).toBe(false);

    fireEvent.submit(document.querySelector("form")!);
    expect((screen.getByRole("button", { name: "로그인 중…" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(readState().user?.id).toBe("u-1"));
    expect(calls).toEqual([
      { url: "/api/auth/login-method", body: { username: "owner" } },
      { url: "/api/auth/login", body: { username: "owner", password: "secret-password" } },
    ]);
    expect(readState().view).toBe("explore");
    expect(visited).toEqual([]);
    expect(get(toasts)).toEqual([]);
  });

  it("goes back to the first step when the name is changed, dropping the typed password", async () => {
    const calls = stubAuthFetch({ "/api/auth/login-method": () => jsonRes({ method: "password" }) });
    render(<AuthView bootstrap={sso()} />);
    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    fireEvent.change(passwordInput()!, { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 보기" }));

    // Only white space around the same name: still the same account.
    typeUsername("owner ");
    expect(passwordInput()!.value).toBe("secret-password");

    typeUsername("owner2");
    expect(passwordInput()).toBeNull();
    expect(screen.getByRole("button", { name: "다음" })).toBeTruthy();

    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    expect(passwordInput()!.value).toBe("");
    expect(passwordInput()!.type).toBe("password");
    expect(calls.map((call) => call.body)).toEqual([{ username: "owner" }, { username: "owner2" }]);
  });

  it("sends an account that has moved to the login server, with the name as a hint", async () => {
    const visited = watchNavigation();
    const calls = stubAuthFetch({ "/api/auth/login-method": () => jsonRes({ method: "sso" }) });
    render(<AuthView bootstrap={sso({ signupMode: "approval" })} />);
    typeUsername("kim.영희+a");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(visited).toEqual(["/api/auth/oidc/start?hint=kim.%EC%98%81%ED%9D%AC%2Ba"]));
    expect(calls).toEqual([{ url: "/api/auth/login-method", body: { username: "kim.영희+a" } }]);
    // Never a password field, and the screen stays busy until the page is gone.
    expect(passwordInput()).toBeNull();
    expect((screen.getByRole("button", { name: "이동 중…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("auth-submit-status")!.textContent).toBe("로그인 화면으로 이동하는 중입니다.");
    expect(usernameInput().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "가입 신청" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    // Back/forward brought the page back from the cache: usable again.
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect((screen.getByRole("button", { name: "다음" }) as HTMLButtonElement).disabled).toBe(false);
    expect(usernameInput().disabled).toBe(false);
  });

  it("goes to the login server when the password login says the account has moved meanwhile", async () => {
    const visited = watchNavigation();
    stubAuthFetch({
      "/api/auth/login-method": () => jsonRes({ method: "password" }),
      "/api/auth/login": () => jsonRes({ error: "이 계정은 통합 로그인으로 로그인합니다.", sso: true }, 409),
    });
    render(<AuthView bootstrap={sso()} />);
    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    fireEvent.change(passwordInput()!, { target: { value: "secret-password" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(visited).toEqual(["/api/auth/oidc/start?hint=owner"]));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "이동 중…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(readState().user).toBeNull();
  });

  it("shows any other refusal of the password login, and lets the form be used again", async () => {
    const visited = watchNavigation();
    let status = 401;
    stubAuthFetch({
      "/api/auth/login-method": () => jsonRes({ method: "password" }),
      "/api/auth/login": () => jsonRes({ error: "사용자명 또는 비밀번호가 올바르지 않습니다." }, status),
    });
    render(<AuthView bootstrap={sso()} />);
    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    fireEvent.change(passwordInput()!, { target: { value: "wrong-password" } });
    fireEvent.submit(document.querySelector("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("사용자명 또는 비밀번호가 올바르지 않습니다.");
    expect((screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement).disabled).toBe(false);
    expect(passwordInput()!.value).toBe("wrong-password");

    // A 409 that does not carry `sso` is an error like any other.
    status = 409;
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect((screen.getByRole("button", { name: "로그인" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).toBe("사용자명 또는 비밀번호가 올바르지 않습니다.");
    expect(visited).toEqual([]);
  });

  it("shows a failed name check and stays on the first step — also for an answer it does not know", async () => {
    const visited = watchNavigation();
    let answer: () => unknown = () => jsonRes({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, 429);
    stubAuthFetch({ "/api/auth/login-method": () => answer() });
    render(<AuthView bootstrap={sso()} />);
    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    expect((screen.getByRole("button", { name: "다음" }) as HTMLButtonElement).disabled).toBe(false);
    expect(passwordInput()).toBeNull();

    answer = () => jsonRes({ method: "passkey" });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("로그인 방법을 확인하지 못했습니다. 다시 시도해 주세요."));
    expect(passwordInput()).toBeNull();
    expect(visited).toEqual([]);
  });

  it("has no signup form: 가입 신청 goes to the login server's registration, and says who approves", () => {
    const visited = watchNavigation();
    const calls = stubAuthFetch({});
    render(<AuthView bootstrap={sso({ signupMode: "approval" })} />);
    expect(screen.queryByRole("button", { name: "가입 승인 요청" })).toBeNull();
    const note = screen.getByText("가입 신청을 마치면 관리자가 승인한 뒤 로그인할 수 있습니다.");
    expect(note.closest(".auth-switch")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "가입 신청" }));
    expect(visited).toEqual(["/api/auth/oidc/start?register=1"]);
    expect(document.querySelector('input[name="displayName"]')).toBeNull();
    expect(passwordInput()).toBeNull();
    expect(calls).toEqual([]);
    // One navigation, however often it is pressed.
    expect((screen.getByRole("button", { name: "가입 신청" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "이동 중…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a closed signup is closed, with no way to register", () => {
    render(<AuthView bootstrap={sso({ signupMode: "closed" })} />);
    expect(screen.getByText("현재 회원가입을 받지 않습니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "가입 신청" })).toBeNull();
    expect(screen.getByRole("button", { name: "다음" })).toBeTruthy();
  });

  it("is one button on a first run: the first account registered becomes the administrator — also when the bootstrap arrives later", () => {
    const visited = watchNavigation();
    const view = render(<AuthView bootstrap={null} />);
    // No bootstrap yet: the built-in form, as before.
    expect(passwordInput()).not.toBeNull();

    view.rerender(<AuthView bootstrap={sso({ needsSetup: true, signupMode: "approval" })} />);
    expect(screen.getByText("첫 실행 · 관리자 설정")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("관리자 계정 만들기");
    expect(screen.getByText("서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다.")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector(".auth-switch")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "관리자 계정 만들기" }));
    expect(visited).toEqual(["/api/auth/oidc/start?register=1"]);
    expect((screen.getByRole("button", { name: "이동 중…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["suspended", "비활성화된 계정입니다. 관리자 승인이나 문의가 필요합니다."],
    ["closed", "현재 회원가입이 비활성화되어 있습니다. 관리자에게 문의해 주세요."],
    ["full", "지금은 가입 신청이 많아 새 신청을 받을 수 없습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요."],
    ["name", "이 사용자명은 사용할 수 없습니다. 관리자에게 문의해 주세요."],
    ["failed", "로그인을 마치지 못했습니다. 다시 시도해 주세요."],
    ["something-new", "로그인을 마치지 못했습니다. 다시 시도해 주세요."],
    ["constructor", "로그인을 마치지 못했습니다. 다시 시도해 주세요."],
  ])("says why a login on the login server gave no session (?auth=%s), and takes the code out of the address", (code, text) => {
    history.replaceState(null, "", `${location.pathname}?auth=${code}&keep=1#/share/abc`);
    render(<AuthView bootstrap={sso()} />);
    expect(screen.getByRole("alert").textContent).toBe(text);
    expect(screen.queryByText(/승인 대기/)).toBeNull();
    // Only the code goes; the rest of the address stays as it was.
    expect(location.search).toBe("?keep=1");
    expect(location.hash).toBe("#/share/abc");
  });

  it("says a new registration waits for approval (?auth=pending), until the next attempt", async () => {
    history.replaceState(null, "", `${location.pathname}?auth=pending`);
    stubAuthFetch({ "/api/auth/login-method": () => jsonRes({ method: "password" }) });
    render(<AuthView bootstrap={sso({ signupMode: "approval" })} />);
    const note = screen.getByText("가입 요청이 승인 대기 상태입니다. 관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.");
    expect(note.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(location.search).toBe("");

    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(passwordInput()).not.toBeNull());
    expect(screen.queryByText(/승인 대기/)).toBeNull();
  });

  it("shows no notice without a code", () => {
    history.replaceState(null, "", `${location.pathname}?auth=`);
    render(<AuthView bootstrap={sso()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/승인 대기/)).toBeNull();
    expect(location.search).toBe("");
  });

  it("keeps a share link across the trip to the login server, and puts it back once", async () => {
    const visited = watchNavigation();
    stubAuthFetch({ "/api/auth/login-method": () => jsonRes({ method: "sso" }) });
    history.replaceState(null, "", `${location.pathname}#/share/abc`);
    render(<AuthView bootstrap={sso()} />);
    expect(screen.getByRole("note").textContent).toBe("공유받은 PPT를 보려면 Noah에 로그인하세요.");
    typeUsername("owner");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(visited).toHaveLength(1));

    // The login server sends the browser back to `/` (or `/?auth=…`) with no fragment.
    history.replaceState(null, "", `${location.pathname}?auth=failed`);
    restoreLoginReturnHash();
    expect(location.hash).toBe("#/share/abc");
    expect(location.search).toBe("?auth=failed");
    // Once: a later plain visit is not sent to the old link.
    history.replaceState(null, "", location.pathname);
    restoreLoginReturnHash();
    expect(location.hash).toBe("");
  });

  it("keeps nothing but a share link, never replaces a fragment already in the address, and drops a stale one", () => {
    const visited = watchNavigation();
    history.replaceState(null, "", `${location.pathname}#/admin/users`);
    render(<AuthView bootstrap={sso({ signupMode: "approval" })} />);
    fireEvent.click(screen.getByRole("button", { name: "가입 신청" }));
    expect(visited).toHaveLength(1);
    history.replaceState(null, "", location.pathname);
    restoreLoginReturnHash();
    expect(location.hash).toBe("");

    sessionStorage.setItem("noah.loginReturnHash", JSON.stringify({ hash: "#/share/abc", at: Date.now() }));
    history.replaceState(null, "", `${location.pathname}#/share/other`);
    restoreLoginReturnHash();
    expect(location.hash).toBe("#/share/other");
    expect(sessionStorage.getItem("noah.loginReturnHash")).toBeNull();

    history.replaceState(null, "", location.pathname);
    sessionStorage.setItem("noah.loginReturnHash", JSON.stringify({ hash: "#/share/abc", at: Date.now() - 16 * 60 * 1000 }));
    restoreLoginReturnHash();
    expect(location.hash).toBe("");
    sessionStorage.setItem("noah.loginReturnHash", "not json");
    restoreLoginReturnHash();
    expect(location.hash).toBe("");
  });
});
