import { expect, test } from "@playwright/test";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

test("system stays checked and locked with empty saved selection and old deny-all policy", async ({ page }) => {
  const user = {
    id: "user-1", username: "owner", displayName: "Owner", alias: "Noah", bio: "", intro: "",
    hashtags: [], roles: [], groups: [], secretNames: [], gitTokenSet: true, knowledgeRepo: "owner/knowledge",
    onboardedAt: "2026-09-01T00:00:00Z", lastSeenRelease: CURRENT_RELEASE_ID,
    mcpToolGroupsDefault: [], allowedMcpToolGroups: [],
  };
  const avatar = { ...user, visibility: "private", hasImage: false, pluginCount: 0, sharesGroup: false, isOwn: true, elevated: true, plugins: [], persona: "" };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { requests: [], notifications: [], groups: [], skills: [], plugins: [] };
    if (path === "/api/bootstrap") body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    else if (path === "/api/me") body = { user };
    else if (path === "/api/avatars") body = { avatars: [avatar] };
    else if (path === "/api/avatars/user-1") body = { avatar };
    else if (path === "/api/conversations") body = { conversations: [] };
    else if (path === "/api/chat/runs") body = { run: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Noah 아바타와 대화", exact: true }).click();
  await page.locator(".composer-tools-btn").click();
  const panel = page.getByRole("group", { name: "이 대화에서 사용할 MCP 도구" });
  const system = panel.locator("label").filter({ hasText: "항상 사용" }).getByRole("checkbox");
  await expect(system).toBeChecked();
  await expect(system).toBeDisabled();
  const canvas = panel.locator("label").filter({ hasText: "캔버스" }).getByRole("checkbox");
  await expect(canvas).not.toBeChecked();
  await expect(canvas).toBeDisabled();
  await expect(page.locator(".composer-tools-btn")).toContainText("1/8");
  expect(errors).toEqual([]);
});
