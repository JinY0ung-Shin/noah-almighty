// The human-to-human DM dock. What only a real browser can settle is pinned
// here: that the dock is NON-modal (the app behind it keeps working), that the
// bar's badge and label track the inbox while collapsed, that a failed send
// keeps its draft AND its nonce, that the bottom sheet follows a finger, and
// that the open thread survives a reload.
//
// MOTION: playwright.config sets `reducedMotion: "reduce"` at the top level of
// `use`, but Playwright 1.61 only reads that key under `contextOptions` — so it
// is inert and this suite really runs with motion ENABLED. Rather than depend on
// either reading, the two trailing describe blocks emulate the media feature
// per page and assert which mode they got, so the spring path and the
// cross-fade path are both covered whichever way the config is later fixed.
import { expect, test, type Page } from "@playwright/test";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";
import type { DirectMessage } from "../../src/shared/directMessages.js";

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

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const XSS = "<img src=x onerror=alert(1)> 직접 답장";

/** Local-clock ISO for today, so the day separator must read "오늘". */
function today(hour: number, minute: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).toISOString();
}

interface DmMock {
  unread: number;
  /** POST /api/dm/:peer/read count — polled, since acknowledge is fire-and-forget. */
  reads: number;
  /** Every send body the server saw, so the retry's nonce is assertable. */
  posts: { text: string; nonce: string }[];
  messages: DirectMessage[];
  failFirstSend: boolean;
  errors: string[];
}

async function install(page: Page, options: { failFirstSend?: boolean } = {}): Promise<DmMock> {
  const state: DmMock = {
    unread: 2,
    reads: 0,
    posts: [],
    failFirstSend: options.failFirstSend ?? false,
    errors: [],
    // Two of MY messages, the earlier one already opened by the peer and the
    // latest not: the exact state a read-receipt boundary has to distinguish.
    messages: [
      { id: 1, senderId: "peer", recipientId: admin.id, text: "안녕하세요", createdAt: today(9, 1), readAt: null },
      { id: 2, senderId: admin.id, recipientId: "peer", text: "네, 반갑습니다", createdAt: today(9, 2), readAt: today(9, 4) },
      { id: 3, senderId: "peer", recipientId: admin.id, text: "잠깐 시간 되세요?", createdAt: today(9, 3), readAt: null },
      { id: 4, senderId: admin.id, recipientId: "peer", text: "확인해 보고 답드릴게요", createdAt: today(9, 5), readAt: null },
    ],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = {};
    if (path === "/api/bootstrap") body = { needsSetup: false, githubHost: "github.com", signupMode: "open" };
    else if (path === "/api/me") body = { user: { ...admin, roles: [] } };
    else if (path === "/api/avatars") body = { avatars: [{ ...admin, hasImage: false }] };
    else if (path === "/api/conversations") body = { conversations: [] };
    else if (path.endsWith("/knowledge/requests")) body = { requests: [] };
    else if (path.endsWith("/notifications")) body = { notifications: [] };
    else if (path.endsWith("/plugins")) body = { plugins: [] };
    else if (path === "/api/dm") {
      body = {
        unread: state.unread,
        windowMinutes: 60,
        peers: [
          { id: "peer", username: "minji", displayName: "이민지", online: true, available: true, unread: state.unread },
          { id: "other", username: "other", displayName: "다른 사용자", online: false, available: true, unread: 0 },
        ],
      };
    } else if (path === "/api/dm/peer/read") {
      state.unread = 0;
      state.reads += 1;
      body = { ok: true };
    } else if (path === "/api/dm/peer" && method === "POST") {
      const payload = route.request().postDataJSON() as { text: string; nonce: string };
      state.posts.push(payload);
      if (state.failFirstSend && state.posts.length === 1) {
        // The write LANDED but the response never arrived — the exact case the
        // nonce exists for. The retry must replay, not deliver a second copy.
        state.messages.push({
          id: state.messages.length + 1,
          senderId: admin.id,
          recipientId: "peer",
          text: payload.text,
          createdAt: new Date().toISOString(),
          readAt: null,
        });
        await route.abort("failed");
        return;
      }
      const replay = state.messages.find((item) => item.senderId === admin.id && item.text === payload.text);
      const message =
        replay ??
        ({
          id: state.messages.length + 1,
          senderId: admin.id,
          recipientId: "peer",
          text: payload.text,
          createdAt: new Date().toISOString(),
          readAt: null,
        } satisfies DirectMessage);
      if (!replay) state.messages.push(message);
      await route.fulfill({
        status: replay ? 200 : 201,
        contentType: "application/json",
        body: JSON.stringify({ message }),
      });
      return;
    } else if (path === "/api/dm/peer") body = { messages: state.messages, hasMore: false };
    else if (path === "/api/dm/other") body = { messages: [], hasMore: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return state;
}

const bar = (page: Page) => page.locator(".dm-dock-bar");
const panel = (page: Page) => page.locator(".dm-dock-panel");
const composer = (page: Page) => panel(page).getByRole("textbox", { name: "DM 메시지 입력" });

/** Current presentation value of the panel's spring-driven transform. */
const translateY = (page: Page) =>
  panel(page).evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);

/** Expand the dock and open 이민지's thread — the start of most scenarios. */
async function openThread(page: Page): Promise<void> {
  await bar(page).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: /이민지/ }).click();
  await expect(panel(page).getByText("안녕하세요", { exact: true })).toBeVisible();
}

test("dock bar carries the inbox, expands into a non-modal panel, and keeps polling", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const state = await install(page);
  await page.goto("/");

  // Collapsed: a labelled pill with the online count and the unread badge, and
  // nothing that behaves like a dialog.
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("메시지");
  await expect(bar(page)).toContainText("접속 1");
  await expect(bar(page).locator(".tag.accent")).toHaveText("2");
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);

  // The pill publishes its own footprint so the chat composer's hint row can
  // keep its status controls out from under it. Must cover the whole bar.
  const barWidth = (await bar(page).boundingBox())!.width;
  const inset = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dm-dock-inset")),
  );
  expect(Number.isFinite(inset)).toBe(true);
  expect(inset).toBeGreaterThanOrEqual(barWidth);

  await bar(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("role", "complementary");
  await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[role=dialog]")).toHaveCount(0);

  // Non-modal: no scrim, no focus trap — the rail still navigates underneath and
  // the panel is untouched by it.
  await expect(page.locator(".view-header h1")).toHaveText("탐색");
  await page.locator(".rail-nav").getByRole("button", { name: "알림" }).click();
  await expect(page.locator(".view-header h1")).toHaveText("알림");
  await expect(panel(page)).toBeVisible();

  // Thread mode: every mocked message, one day separator, and a read receipt.
  await panel(page).getByRole("button", { name: /이민지/ }).click();
  await expect(panel(page).getByText("안녕하세요", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("네, 반갑습니다", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("잠깐 시간 되세요?", { exact: true })).toBeVisible();
  await expect(panel(page).locator(".dm-dock-day")).toHaveText("오늘");
  await expect(panel(page).locator(".dm-dock-who strong")).toHaveText("이민지");
  // The composer is the chat composer's own building blocks, not a look-alike:
  // the rounded box with the icon-only accent send button inside it.
  await expect(composer(page)).toBeVisible();
  await expect(panel(page).locator(".composer-box .send-button")).toBeVisible();
  await expect.poll(() => state.reads).toBeGreaterThan(0);
  await expect(bar(page).locator(".tag.accent")).toHaveCount(0);

  // A message that arrives while the thread is open shows up on the next poll.
  state.messages.push({
    id: state.messages.length + 1,
    senderId: "peer",
    recipientId: admin.id,
    text: "실시간 답장",
    createdAt: new Date().toISOString(),
    readAt: null,
  });
  await expect(panel(page).getByText("실시간 답장", { exact: true })).toBeVisible({ timeout: 10_000 });

  expect(state.errors).toEqual([]);
});

test("the sender's 읽음 boundary follows what the other person has opened", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const state = await install(page);
  await page.goto("/");
  await openThread(page);

  // A boundary, not a label per bubble: 읽음 under the newest message the peer
  // has opened, 안 읽음 under the ones after it, nothing on the rest.
  const mine = panel(page).locator(".dm-dock-bubble.mine");
  await expect(mine).toHaveCount(2);
  await expect(mine.nth(0).locator(".dm-dock-receipt")).toHaveText("읽음");
  await expect(mine.nth(1).locator(".dm-dock-receipt")).toHaveText("안 읽음");
  await expect(panel(page).getByText("읽음", { exact: true })).toHaveCount(1);
  await expect(panel(page).getByText("안 읽음", { exact: true })).toHaveCount(1);
  // Never on the other person's own bubbles — their read stamp is my reading.
  await expect(panel(page).locator(".dm-dock-bubble:not(.mine) .dm-dock-receipt")).toHaveCount(0);
  // The read mark carries when, which the bubble itself has no room to say.
  await expect(mine.nth(0).locator(".dm-dock-receipt")).toHaveAttribute("title", /에 읽음$/);

  // The peer opens the latest one. The mark moves on the thread's existing 5s
  // refresh — no receipt-specific request, so nothing new is mocked here.
  state.messages = state.messages.map((item) => (item.id === 4 ? { ...item, readAt: new Date().toISOString() } : item));

  await expect(mine.nth(1).locator(".dm-dock-receipt")).toHaveText("읽음", { timeout: 10_000 });
  await expect(panel(page).getByText("안 읽음", { exact: true })).toHaveCount(0);
  // And the boundary MOVED rather than multiplied: the earlier one is bare now.
  await expect(panel(page).getByText("읽음", { exact: true })).toHaveCount(1);
  await expect(mine.nth(0).locator(".dm-dock-receipt")).toHaveCount(0);

  expect(state.errors).toEqual([]);
});

test("drafts survive a peer switch and a failed send retries on the same nonce", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const state = await install(page, { failFirstSend: true });
  await page.goto("/");
  await openThread(page);

  // Per-peer drafts: switching away and back restores what was typed.
  await composer(page).fill("보존할 초안");
  await panel(page).getByRole("button", { name: "대화 목록으로" }).click();
  await panel(page).getByRole("button", { name: /다른 사용자/ }).click();
  await expect(composer(page)).toHaveValue("");
  await panel(page).getByRole("button", { name: "대화 목록으로" }).click();
  await panel(page).getByRole("button", { name: /이민지/ }).click();
  await expect(composer(page)).toHaveValue("보존할 초안");

  // First attempt fails at the network. The draft must stay put — retyping a
  // lost message is the whole failure people remember.
  await composer(page).fill(XSS);
  await composer(page).press("Enter");
  await expect(panel(page).getByRole("alert")).toContainText("서버에 연결할 수 없습니다");
  await expect(composer(page)).toHaveValue(XSS);

  await panel(page).getByRole("button", { name: "보내기" }).click();
  await expect(panel(page).getByText(XSS, { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("");

  // Same nonce on the retry, so the server replays instead of double-sending.
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].nonce).toBe(state.posts[0].nonce);
  expect(state.posts[0].nonce).toMatch(/^[a-zA-Z0-9_-]{16,80}$/);
  expect(state.messages.filter((item) => item.text === XSS)).toHaveLength(1);

  // Message bodies are interpolated text, never markup.
  await expect(panel(page).locator("img")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("collapsing keeps the selected peer on the bar, and Escape returns focus to it", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const state = await install(page);
  await page.goto("/");
  await openThread(page);

  await panel(page).getByRole("button", { name: "접기" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("이민지");
  await expect(bar(page)).toHaveAttribute("aria-expanded", "false");

  // A user-initiated expand moves focus into the thread…
  await bar(page).click();
  await expect(composer(page)).toBeFocused();
  // …and Escape from inside the dock collapses it and hands focus back.
  await composer(page).press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(bar(page)).toBeFocused();

  expect(state.errors).toEqual([]);
});

test("an open thread is restored after a reload without stealing focus", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const state = await install(page);
  await page.goto("/");
  await openThread(page);

  await page.reload();

  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".dm-dock-who strong")).toHaveText("이민지");
  await expect(panel(page).getByText("안녕하세요", { exact: true })).toBeVisible();
  // A restore is not a gesture: focusing the composer here would pop a mobile
  // keyboard on every page load.
  await expect(composer(page)).not.toBeFocused();

  expect(state.errors).toEqual([]);
});

test("mobile: the panel is a full-width sheet, drags closed, and hides behind the rail", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  const state = await install(page);
  await page.goto("/");

  await bar(page).click();
  await expect(panel(page)).toBeVisible();

  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await panel(page).boundingBox();
  expect(Math.round(box!.width)).toBe(viewportWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);

  const grabber = panel(page).getByRole("button", { name: "아래로 끌어 접기" });
  await expect(grabber).toBeVisible();

  await panel(page).getByRole("button", { name: /이민지/ }).click();
  await expect(panel(page).getByText("안녕하세요", { exact: true })).toBeVisible();

  // Dragging the grabber past the halfway mark dismisses the sheet.
  const handle = await grabber.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2 + step * 50);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await expect(panel(page)).toBeHidden();
  await expect(bar(page)).toBeVisible();

  // The rail drawer owns the screen while it is open, so the dock steps aside.
  await page.locator(".rail-toggle").click();
  await expect(page.locator(".dm-dock")).toBeHidden();
  expect(await page.locator(".dm-dock").evaluate((element) => element.hasAttribute("hidden"))).toBe(true);
  // Covering nothing means reserving nothing, so the property is withdrawn.
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dm-dock-inset")),
    )
    .toBe("");

  expect(state.errors).toEqual([]);
});

// The tests above run with reduced motion, which short-circuits springValue()
// — so the actual spring never executes there. These two emulate the media
// feature per page (Playwright 1.61 exposes `reducedMotion` on emulateMedia,
// not on test.use), because "the panel rises and can be caught mid-flight" is
// exactly the kind of claim only a real browser settles.
test.describe("with motion enabled", () => {
  test("the panel springs up from below and settles at rest", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const state = await install(page);
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
    await expect(bar(page)).toBeVisible();

    // Record every frame the spring writes, so the travel is provable without
    // racing the animation from Node.
    await page.evaluate(() => {
      const samples: number[] = [];
      (window as unknown as { __dmY: number[] }).__dmY = samples;
      new MutationObserver(() => {
        const element = document.querySelector<HTMLElement>(".dm-dock-panel");
        if (element) samples.push(Number.parseFloat(element.style.getPropertyValue("--dm-dock-y")) || 0);
      }).observe(document.querySelector(".dm-dock")!, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    });

    await bar(page).click();
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => translateY(page)).toBeLessThan(0.5);

    const samples = await page.evaluate(() => (window as unknown as { __dmY: number[] }).__dmY);
    // It rose from off-screen over many frames rather than appearing at rest.
    expect(samples.length).toBeGreaterThan(5);
    expect(Math.max(...samples)).toBeGreaterThan(100);
    expect(samples.at(-1)).toBeLessThan(1);

    expect(state.errors).toEqual([]);
  });

  test("a collapse caught mid-flight retargets instead of restarting", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const state = await install(page);
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
    await bar(page).click();
    await expect.poll(() => translateY(page)).toBeLessThan(0.5);

    // Synthetic clicks: the collapsing panel still covers the bar, so a real
    // click would queue behind it and never land mid-flight.
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>(".dm-dock-panel .dm-dock-collapse")!.click(),
    );
    await page.waitForTimeout(120);
    expect(await translateY(page)).toBeGreaterThan(8);

    await page.evaluate(() => document.querySelector<HTMLButtonElement>(".dm-dock-bar")!.click());
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => translateY(page)).toBeLessThan(0.5);
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");

    expect(state.errors).toEqual([]);
  });
});

// The accessibility variant: no vestibular travel, a 120ms cross-fade instead.
// DESIGN §2.5 asks for the same feedback in a different form, so what matters is
// that the panel still opens, still closes, and never translates on the way.
test.describe("with reduced motion", () => {
  test("the panel cross-fades in place instead of travelling", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const state = await install(page);
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    await page.evaluate(() => {
      const samples: number[] = [];
      (window as unknown as { __dmY: number[] }).__dmY = samples;
      new MutationObserver(() => {
        const element = document.querySelector<HTMLElement>(".dm-dock-panel");
        if (element) samples.push(Number.parseFloat(element.style.getPropertyValue("--dm-dock-y")) || 0);
      }).observe(document.querySelector(".dm-dock")!, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    });

    await bar(page).click();
    await expect(panel(page)).toBeVisible();
    // At rest from the first paint — no spring frames at all.
    expect(await translateY(page)).toBe(0);

    await panel(page).getByRole("button", { name: /이민지/ }).click();
    await expect(panel(page).getByText("안녕하세요", { exact: true })).toBeVisible();
    await panel(page).getByRole("button", { name: "접기" }).click();
    await expect(panel(page)).toBeHidden();
    await expect(bar(page)).toBeVisible();

    const samples = await page.evaluate(() => (window as unknown as { __dmY: number[] }).__dmY);
    expect(samples.every((value) => Math.abs(value) < 0.5)).toBe(true);

    expect(state.errors).toEqual([]);
  });
});
