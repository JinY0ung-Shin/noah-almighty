// The login / signup / first-run screen. (AuthView had no component test before
// the React port; these pin what the port must keep.)
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthView from "../src/client/src/components/AuthView";
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
  history.replaceState(null, "", location.pathname);
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
