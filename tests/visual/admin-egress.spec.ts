import { expect, test, type Page } from "@playwright/test";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

async function mock(page: Page, conflict = false) {
  const user = { id: "admin-1", username: "admin", displayName: "관리자", roles: ["admin"], groups: [], hashtags: [], secretNames: [], onboardedAt: "2026-09-01", lastSeenRelease: CURRENT_RELEASE_ID };
  let state = { configured: true, proxyReady: true, domains: [".blocked.example"], revision: "a".repeat(32), appliedAt: "2026-09-08T02:00:00Z", appliedBy: user.id };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { requests: [], notifications: [], plugins: [], groups: [], skills: [] };
    let status = 200;
    if (path === "/api/bootstrap") body = { needsSetup: false, signupMode: "open", githubHost: "github.com" };
    else if (path === "/api/me") body = { user };
    else if (path === "/api/avatars") body = { avatars: [] };
    else if (path === "/api/conversations") body = { conversations: [] };
    else if (path === "/api/admin/stats") body = { stats: {} };
    else if (path === "/api/admin/users") body = { users: [] };
    else if (path === "/api/audit") body = { audit: [] };
    else if (path === "/api/admin/system") body = { system: { signupMode: "open", toolSkillPolicy: { disabledSkills: [] }, hexSshToolPolicy: { owner: [], trusted: [] } } };
    else if (path === "/api/admin/presence") body = { presence: { users: [], windowMinutes: 60 } };
    else if (path === "/api/admin/egress") {
      if (route.request().method() === "PUT") {
        expect(route.request().headers()["x-noah-egress-admin"]).toBe("1");
        if (conflict) {
          status = 409;
          body = { error: "다른 관리자가 목록을 변경했습니다. 최신 목록을 불러온 후 다시 적용하세요." };
        } else {
          const sent = route.request().postDataJSON();
          expect(sent.revision).toBe(state.revision);
          state = { ...state, domains: sent.domains, revision: "b".repeat(32) };
          body = state;
        }
      } else body = state;
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return errors;
}

test("admin adds and removes domains, keeps drafts across tabs and applies policy", async ({ page }, testInfo) => {
  const errors = await mock(page);
  await page.goto("/#/admin/access");
  await expect(page.getByRole("heading", { name: "외부 통신 차단" })).toBeVisible();
  await page.getByLabel("차단할 도메인", { exact: true }).fill("upload.example.org");
  await page.getByRole("button", { name: "목록에 추가" }).click();
  await page.getByRole("tab", { name: "사용자", exact: true }).click();
  await page.getByRole("tab", { name: "가입·접근", exact: true }).click();
  await expect(page.getByText("upload.example.org", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: ".blocked.example 삭제", exact: true }).click();
  await page.getByRole("button", { name: "저장하고 적용", exact: true }).click();
  await expect(page.getByText("전체 아바타에 차단 목록을 적용했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "저장하고 적용", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("admin-egress.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("conflict keeps the draft and marks the applied state as unconfirmed", async ({ page }) => {
  const errors = await mock(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/admin/access");
  await page.getByRole("button", { name: ".blocked.example 삭제", exact: true }).click();
  await page.getByRole("button", { name: "저장하고 적용", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "다른 관리자가" })).toBeVisible();
  await expect(page.getByText("현재 적용 상태를 확인하려면 목록을 다시 불러오세요.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "저장하고 적용", exact: true })).toBeDisabled();
  await expect(page.getByText("차단할 도메인이 없습니다.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
