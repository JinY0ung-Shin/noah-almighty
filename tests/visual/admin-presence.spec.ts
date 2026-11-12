import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// The admin presence badge in the rail footer. Geometry/structure checks only
// (no screenshots). What needs guarding is a silent failure mode: the list is a
// grid whose rows size to the WIDEST row, and it is its own scroll container, so
// a long display name that can't shrink widens every row and pushes the
// timestamps outside the rail with nothing to reveal them. Only measured boxes
// catch it — the typecheck and the component tests stay green throughout.
// Verified to fail: drop `overflow: hidden` from .rail-presence-name and the
// long row's timestamp lands 133px past the list's right edge.

const admin = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
  roles: ["admin"],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  // An unseen release opens the what's-new modal, whose overlay eats every click.
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: null,
  gitTokenSet: false,
  secretNames: [],
  groups: [],
};

const LONG_NAME = "아주아주아주아주길고길어서반드시줄임표가필요한이름을가진사용자";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * One mock for both tests. Every endpoint the boot path touches must be answered
 * with its real shape — an unhandled route falls through to `{}` and App.tsx
 * throws on `state.knowledgeRequests.filter` while it renders — and a render
 * error in App leaves only the AppBoundary's fallback screen
 * (components/ErrorBoundary.tsx), not the rail these tests look at.
 */
async function mockApp(page: Page, { isAdmin }: { isAdmin: boolean }): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user: { ...admin, roles: isAdmin ? ["admin"] : [] } };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...admin, sharesGroup: false, hasImage: false }] };
    } else if (path === "/api/admin/presence") {
      if (!isAdmin) {
        // A non-admin must never reach here; 403 so a stray request fails loudly.
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "nope" }) });
        return;
      }
      body = {
        presence: {
          windowMinutes: 60,
          users: [
            // The viewer's own row must never reach the list or the count.
            { id: "user-1", username: "jinyoung", displayName: "김진영", hasImage: false, lastSeenAt: minutesAgo(0) },
            { id: "u-2", username: "minji", displayName: "이민지", hasImage: false, lastSeenAt: minutesAgo(0) },
            { id: "u-3", username: "long", displayName: LONG_NAME, hasImage: false, lastSeenAt: minutesAgo(2) },
          ],
        },
      };
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path.endsWith("/knowledge/requests")) {
      body = { requests: [] };
    } else if (path.endsWith("/notifications")) {
      body = { notifications: [] };
    } else if (path.endsWith("/plugins")) {
      body = { plugins: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("presence list keeps every row inside the rail, ellipsizing long names", async ({ page }) => {
  await mockApp(page, { isAdmin: true });
  await page.goto("/");

  const toggle = page.getByRole("button", { name: /접속 2/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator("#rail-presence-list")).toBeVisible();

  const measured = await page.evaluate((longName) => {
    const rail = document.querySelector(".rail") as HTMLElement;
    const list = document.getElementById("rail-presence-list") as HTMLElement;
    const listRight = list.getBoundingClientRect().right;
    return {
      railScrollW: rail.scrollWidth,
      railClientW: rail.clientWidth,
      listScrollW: list.scrollWidth,
      listClientW: list.clientWidth,
      names: [...list.querySelectorAll(".rail-presence-name")].map((n) => n.textContent),
      // A timestamp pushed past the list's right edge is invisible to the admin.
      agesOutside: [...list.querySelectorAll(".rail-presence-age")].filter(
        (age) => age.getBoundingClientRect().right > listRight + 1,
      ).length,
      longNameEllipsized: [...list.querySelectorAll(".rail-presence-name")].some(
        (n) => n.textContent === longName && n.scrollWidth > n.clientWidth,
      ),
    };
  }, LONG_NAME);

  expect(measured.names).toEqual(["이민지", LONG_NAME]);
  expect(measured.agesOutside).toBe(0);
  expect(measured.listScrollW).toBeLessThanOrEqual(measured.listClientW + 1);
  expect(measured.railScrollW).toBeLessThanOrEqual(measured.railClientW + 1);
  expect(measured.longNameEllipsized).toBe(true);
});

test("presence badge is absent for a non-admin", async ({ page }) => {
  await mockApp(page, { isAdmin: false });
  await page.goto("/");

  await expect(page.locator(".rail-user-row")).toBeVisible();
  await expect(page.locator(".rail-presence")).toHaveCount(0);
});
