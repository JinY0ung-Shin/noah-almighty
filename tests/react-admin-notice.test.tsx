// 관리자 공지 — the bar at the top of every screen (components/NoticeBar.tsx)
// and its client state (lib/adminNotice.ts). The server half is pinned in
// tests/routes-admin.test.ts ("admin: notice").
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NoticeBar from "../src/client/src/components/NoticeBar";
import { dismissAdminNotice, refreshAdminNotice, resetAdminNoticeClientState } from "../src/client/src/lib/adminNotice";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { User } from "../src/client/src/lib/types";
import type { AdminNotice } from "../src/shared/adminNotice";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const first: AdminNotice = { id: "n-1", text: "금요일 22시 서버 점검", level: "warn" };
const second: AdminNotice = { id: "n-2", text: "점검이 끝났습니다", level: "info" };

describe("NoticeBar", () => {
  it("says the level in words, shows the text as written, and closes on the button", () => {
    const onDismiss = vi.fn();
    render(<NoticeBar notice={{ text: "<b>굵게</b> https://example.com", level: "urgent" }} onDismiss={onDismiss} />);

    const bar = screen.getByRole("complementary", { name: "관리자 공지" });
    expect(bar.classList.contains("level-urgent")).toBe(true);
    expect(screen.getByText("긴급")).toBeTruthy();
    // Plain text: no element and no link is made out of what the admin typed.
    const text = screen.getByRole("alert");
    expect(text.textContent).toBe("<b>굵게</b> https://example.com");
    expect(text.children.length).toBe(0);
    expect(bar.querySelector("a")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "공지 닫기" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("announces a non-urgent notice politely, and a preview has no close button", () => {
    const { unmount } = render(<NoticeBar notice={first} onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe(first.text);
    expect(screen.getByText("주의")).toBeTruthy();
    unmount();

    render(<NoticeBar notice={first} />);
    expect(screen.getByRole("complementary", { name: "공지 미리 보기" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    // The preview is not a live region: typing in the admin card announces nothing.
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("admin notice client state", () => {
  let calls: { url: string; method: string; body: string | null }[] = [];
  let answers: Record<string, () => Response | Promise<Response>> = {};

  beforeEach(() => {
    calls = [];
    answers = {};
    replaceState({ user: { id: "u-1", roles: [] } as unknown as User });
    resetAdminNoticeClientState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || "GET").toUpperCase();
        calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
        const answer = answers[`${method} ${url}`];
        return answer ? answer() : json({ error: "not found" }, 404);
      }),
    );
  });

  afterEach(() => {
    resetAdminNoticeClientState();
    replaceState({ user: null });
    vi.unstubAllGlobals();
  });

  it("loads the notice in force, and keeps what is shown when a poll fails", async () => {
    answers["GET /api/me/notice"] = () => json({ notice: first });
    await refreshAdminNotice();
    expect(readState().adminNotice).toEqual(first);

    // A failed poll (or a server from before the feature: 404) changes nothing.
    delete answers["GET /api/me/notice"];
    await refreshAdminNotice();
    expect(readState().adminNotice).toEqual(first);

    // The admin hid it: the next poll takes the bar away.
    answers["GET /api/me/notice"] = () => json({ notice: null });
    await refreshAdminNotice();
    expect(readState().adminNotice).toBeNull();
  });

  it("does nothing while logged out", async () => {
    replaceState({ user: null });
    answers["GET /api/me/notice"] = () => json({ notice: first });
    await refreshAdminNotice();
    expect(calls).toEqual([]);
    expect(readState().adminNotice).toBeNull();
  });

  it("closes at once, records the id it saw, and an answer already on its way cannot bring it back", async () => {
    answers["GET /api/me/notice"] = () => json({ notice: first });
    await refreshAdminNotice();

    let release: (value: Response) => void = () => {};
    answers["POST /api/me/notice/dismiss"] = () => new Promise<Response>((resolve) => (release = resolve));
    const closing = dismissAdminNotice(first.id);
    // Gone before the server answered.
    expect(readState().adminNotice).toBeNull();

    // A poll fetched BEFORE the close was recorded still carries the notice.
    await refreshAdminNotice();
    expect(readState().adminNotice).toBeNull();

    release(json({ notice: null }));
    await closing;
    expect(readState().adminNotice).toBeNull();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/me/notice/dismiss");
    expect(JSON.parse(post?.body || "{}")).toEqual({ id: first.id });

    // A NEW notice (the admin saved again) shows.
    answers["GET /api/me/notice"] = () => json({ notice: second });
    await refreshAdminNotice();
    expect(readState().adminNotice).toEqual(second);
  });

  it("shows the notice the admin saved meanwhile, straight from the close's answer", async () => {
    replaceState({ adminNotice: first });
    answers["POST /api/me/notice/dismiss"] = () => json({ notice: second });
    await dismissAdminNotice(first.id);
    expect(readState().adminNotice).toEqual(second);
  });

  it("stays closed for the session when the record fails", async () => {
    replaceState({ adminNotice: first });
    await dismissAdminNotice(first.id); // 404
    expect(readState().adminNotice).toBeNull();
    answers["GET /api/me/notice"] = () => json({ notice: first });
    await refreshAdminNotice();
    expect(readState().adminNotice).toBeNull();
  });
});
