// 관리자 → 사용자 tab with the single sign-on login configured (bootstrap
// `sso`): which accounts still log in with their built-in password — a badge on
// the row and one summary line above the list. Without it, nothing new.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminView from "../src/client/src/views/AdminView";
import { replaceState } from "../src/client/src/lib/state";
import type { AdminUserSummary, BootstrapInfo, User } from "../src/client/src/lib/types";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const userOf = (id: string, builtInPassword: boolean): AdminUserSummary => ({
  id,
  username: id,
  displayName: `사용자 ${id}`,
  roles: [],
  visibility: "group",
  suspended: false,
  hasImage: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: null,
  activeSessions: 0,
  builtInPassword,
});

const BADGE_TITLE = "이 계정은 다음 로그인 때 비밀번호가 통합 로그인으로 옮겨집니다";

async function openUsersTab(users: AdminUserSummary[], sso: boolean | undefined): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/stats")) return json({ stats: {} });
      if (url.includes("/api/admin/system")) return json({ system: { signupMode: "approval" } });
      if (url.includes("/api/admin/users")) return json({ users });
      if (url.includes("/api/audit")) return json({ audit: [] });
      return json({});
    }),
  );
  replaceState({
    user: { id: "admin-1", username: "admin", displayName: "관리자", roles: ["admin"] } as unknown as User,
    bootstrap: { needsSetup: false, signupMode: "approval", ...(sso === undefined ? {} : { sso }) } as BootstrapInfo,
    adminUsers: [],
    adminUserSearch: "",
    adminUserFilter: "all",
  });
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("tab", { name: "사용자" }));
  await screen.findByText(`사용자 ${users[0].id}`);
}

const rowOf = (id: string) => screen.getByText(`사용자 ${id}`).closest(".admin-user") as HTMLElement;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  replaceState({ bootstrap: null, user: null, adminUsers: [] });
});

describe("admin 사용자 tab: accounts whose password has not moved to the single sign-on login", () => {
  it("marks each such account and counts them above the list", async () => {
    await openUsersTab([userOf("old-a", true), userOf("moved", false), userOf("old-b", true)], true);

    const badge = rowOf("old-a").querySelector(".ar-tags .tag[title]") as HTMLElement;
    expect(badge.textContent).toBe("비밀번호 미이전");
    expect(badge.getAttribute("title")).toBe(BADGE_TITLE);
    expect(rowOf("old-b").textContent).toContain("비밀번호 미이전");
    expect(rowOf("moved").textContent).not.toContain("비밀번호 미이전");

    const note = document.querySelector(".admin-users-note") as HTMLElement;
    expect(note.textContent).toBe("비밀번호를 아직 통합 로그인으로 옮기지 않은 계정 2개 · 각 계정이 다음에 로그인할 때 옮겨집니다.");
    // Above the list, inside the tab's own column.
    expect(note.parentElement?.classList.contains("admin-users")).toBe(true);
    expect(note.nextElementSibling?.classList.contains("admin-list")).toBe(true);

    // The count is of every account, not of the rows a search leaves.
    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "moved" } });
    expect(screen.queryByText("사용자 old-a")).toBeNull();
    expect(document.querySelector(".admin-users-note")!.textContent).toContain("계정 2개");
  });

  it("hides the summary line once every account has moved", async () => {
    await openUsersTab([userOf("moved-a", false), userOf("moved-b", false)], true);
    expect(document.querySelector(".admin-users-note")).toBeNull();
    expect(screen.queryByText("비밀번호 미이전")).toBeNull();
  });

  it.each([[false], [undefined]])("shows nothing new without the single sign-on login (sso: %s)", async (sso) => {
    await openUsersTab([userOf("old-a", true), userOf("old-b", true)], sso);
    expect(document.querySelector(".admin-users-note")).toBeNull();
    expect(screen.queryByText("비밀번호 미이전")).toBeNull();
    expect(document.querySelector(`[title="${BADGE_TITLE}"]`)).toBeNull();
  });
});
