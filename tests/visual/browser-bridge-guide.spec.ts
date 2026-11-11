import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// The browser-bridge install guide modal. Geometry only, no screenshots.
//
// This exists because the first version SHIPPED BROKEN and the typecheck stayed
// green: `.modal-card` pins `width: min(460px, 100%)`, so the guide's
// `max-width: 44rem` did nothing and the five-step procedure was crammed into
// the default dialog width. The content also used `.panel-section-head`, a
// settings-panel construct that renders as a nested box inside a dialog.
// Neither failure is visible to a type checker — only a measured layout catches
// them.
//
// Verified to fail: change `.browser-guide-card`'s `width` back to `max-width`
// and the card measures 460px instead of ~640px.

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
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: null,
  gitTokenSet: false,
  secretNames: [],
  groups: [],
  experimentalFeatures: [],
  shellExposedSecretNames: [],
};

const EXTENSION_ID = "gdaheigeedlnhagpmokpmocahgieiobc";

async function mockApp(
  page: Page,
  { isAdmin, multimediaNotice = false }: { isAdmin: boolean; multimediaNotice?: boolean },
): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user: { ...admin, roles: isAdmin ? ["admin"] : [] } };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...admin, sharesGroup: false, hasImage: false }] };
    } else if (path === "/api/browser-extension") {
      // Session-gated but NOT admin-gated: every signed-in user installs the
      // bridge for their own browser.
      body = {
        extensionId: EXTENSION_ID,
        origins: ["https://noah.corp.local/*", "http://localhost:5173/*"],
        multimediaNotice,
      };
    } else if (path === "/api/admin/presence") {
      body = { presence: { windowMinutes: 60, users: [] } };
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

async function openGuide(page: Page): Promise<void> {
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "권한·연결" }).click();
  await page.getByRole("button", { name: "설치 방법 보기" }).click();
  await expect(page.locator(".browser-guide-card")).toBeVisible();
}

test("the guide renders as a full-width dialog, not a nested box", async ({ page }) => {
  await mockApp(page, { isAdmin: true });
  await openGuide(page);

  const measured = await page.evaluate(() => {
    const card = document.querySelector(".browser-guide-card") as HTMLElement;
    const steps = [...card.querySelectorAll<HTMLElement>(".guide-steps > li")];
    const cardBox = card.getBoundingClientRect();
    return {
      cardWidth: cardBox.width,
      // A card taller than its scroll box silently hides the last steps unless
      // it scrolls; `.modal-card` sets overflow-y so this must stay true.
      scrollable: card.scrollHeight > card.clientHeight ? card.scrollHeight > 0 : true,
      overflowY: getComputedStyle(card).overflowY,
      stepCount: steps.length,
      // Every step must sit inside the card — a nested settings-panel box used
      // to push content past the edge.
      stepsOutside: steps.filter(
        (li) =>
          li.getBoundingClientRect().right > cardBox.right + 1 ||
          li.getBoundingClientRect().left < cardBox.left - 1,
      ).length,
      // The step markers are absolutely positioned; if the li lost its padding
      // they would sit on top of the text instead of beside it.
      markersOverlapText: steps.filter((li) => {
        const title = li.querySelector(".guide-step-title") as HTMLElement | null;
        return title ? title.getBoundingClientRect().left < li.getBoundingClientRect().left + 20 : false;
      }).length,
      horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
      overlayParent: (card.closest(".modal-overlay") as HTMLElement).parentElement?.tagName ?? "",
      // Sample the card's own left edge: whatever the browser actually paints
      // there must belong to the dialog, not to chrome layered above it.
      railCoversCard: (() => {
        const hit = document.elementFromPoint(cardBox.left + 4, cardBox.top + cardBox.height / 2);
        return !hit || !hit.closest(".modal-overlay");
      })(),
    };
  });

  // Wider than the 460px default, which is the bug this test was written for.
  expect(measured.cardWidth).toBeGreaterThan(560);
  // The overlay must sit at the top of the document, not inside the settings
  // view. Mounted in place it is a fixed element inside the view's stacking
  // contexts, so the scrim stopped at the content column and the rail — which
  // has its own backdrop-filter — painted over the dialog's left edge.
  // Measuring rects does NOT catch this (they stayed full-viewport the whole
  // time); only the parent does.
  expect(measured.overlayParent).toBe("BODY");
  expect(measured.railCoversCard).toBe(false);
  expect(measured.stepCount).toBe(5);
  expect(measured.stepsOutside).toBe(0);
  expect(measured.markersOverlapText).toBe(0);
  expect(measured.horizontalOverflow).toBe(false);
  expect(measured.overflowY).toBe("auto");
});

test("the guide shows the pinned extension id and the origins it will accept", async ({ page }) => {
  await mockApp(page, { isAdmin: true });
  await openGuide(page);

  // The id is what the user compares against chrome://extensions; a mismatch is
  // the difference between a working install and a silent no-op.
  await expect(page.locator(".guide-id code")).toHaveText(EXTENSION_ID);
  await expect(page.locator(".guide-origins li")).toHaveCount(2);
  // The corp install-location notice is opt-in; a default server must not show it.
  await expect(page.getByText("사내 내규에 따라")).toHaveCount(0);
});

test("the corp Multimedia-folder notice renders when the server enables it", async ({ page }) => {
  await mockApp(page, { isAdmin: true, multimediaNotice: true });
  await openGuide(page);

  await expect(
    page.getByText("사내 내규에 따라 파일 업로드가 가능한 Multimedia 폴더를 사용해 주세요."),
  ).toBeVisible();
});

test("the one-click update connector renders in the bridge card", async ({ page }) => {
  await mockApp(page, { isAdmin: true });
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "권한·연결" }).click();

  // Chromium exposes File System Access, so the connector button must render;
  // its absence would mean the whole update path silently vanished.
  await expect(page.getByRole("button", { name: "확장 폴더 연결 (원클릭 업데이트)" })).toBeVisible();
});

test("a plain member sees the browser bridge card too (general capability)", async ({ page }) => {
  await mockApp(page, { isAdmin: false });
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "권한·연결" }).click();
  await expect(page.getByRole("button", { name: "설치 방법 보기" })).toBeVisible();
});
