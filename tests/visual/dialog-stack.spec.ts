import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Stacked dialogs in a real browser: every dialog listens for keys on `window`,
// and stopPropagation cannot stop a sibling window listener — so a confirmation
// opened over the 예약 작업 편집 form used to take the form down with it on one
// Escape, throwing the edits away (lib/modalBehavior.ts isTopDialogLayer).

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  // An unseen release opens a click-blocking modal (see apple-ui.spec.ts).
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

const routine = {
  id: "routine-1",
  avatarUserId: "user-1",
  conversationId: "conv-routine-1",
  name: "주간 보고",
  prompt: "이번 주 진행 상황을 정리해 줘",
  scheduleKind: "daily",
  minuteOfDay: 540,
  time: "09:00",
  daysOfWeek: null,
  intervalMinutes: null,
  runDate: null,
  enabled: true,
  nextRunAt: "2026-07-13T00:00:00.000Z",
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  completedAt: null,
  createdAt: "2026-07-10T00:00:00.000Z",
};

/** The app booted logged-in with one routine; returns the non-GET requests it received. */
async function mockApp(page: Page): Promise<string[]> {
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    let body: unknown = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "approval", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path === "/api/me/routines") {
      body = { routines: [routine] };
    } else if (path.endsWith("/notifications")) {
      body = { notifications: [] };
    } else if (path.endsWith("/knowledge/requests")) {
      body = { requests: [] };
    } else if (path.endsWith("/plugins")) {
      body = { plugins: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return writes;
}

test("one Escape closes only the confirmation over the 예약 작업 편집 form", async ({ page }) => {
  const writes = await mockApp(page);
  await page.goto("/#/routines");

  await page.getByRole("button", { name: /예약 작업 편집/ }).first().click();
  const form = page.getByRole("dialog", { name: "예약 작업 편집" });
  await expect(form).toBeVisible();

  await form.getByRole("button", { name: "삭제", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "계속 진행할까요?" });
  await expect(confirm).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  // The form under it stays open: not playing an exit (an exiting dialog is
  // still visible for its exit, but inert), focus back inside it, and still
  // there once every exit would have finished.
  const formState = () =>
    page.evaluate(() => {
      const card = document.querySelector(".routine-modal-card");
      return {
        open: Boolean(card && !card.closest("[inert]")),
        focusInside: Boolean(card && card.contains(document.activeElement)),
      };
    });
  await expect.poll(formState).toEqual({ open: true, focusInside: true });
  await page.waitForTimeout(500);
  await expect(form).toBeVisible();
  expect(await formState()).toEqual({ open: true, focusInside: true });

  // Now the form is the top dialog, so the next Escape is its own.
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([]);
});
