import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";
import type { TodoItem, TodoListResponse } from "../../src/shared/todos.js";

// The chat screen's 할 일 card (TodoOverlay.svelte) picks its presentation from the
// chat column's measured width: pinned at the top-right of a ≥1000px column, a
// popover above the composer when narrower, a full-width sheet at ≤860px. These are
// geometry checks (no screenshots): the card stays inside .chat-body, never covers
// the composer or the chat header, the pinned card leaves the transcript text
// alone (its reserve keeps a readable column without a dead gap) on an opaque
// surface while popover/sheet stay frosted, the sheet spans the column, and
// Escape/outside clicks only dismiss a transient card — which only the pinned
// layout brings back on its own.

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "차분하고 유용한 AI 동료를 만들고 있습니다.",
  intro: "함께 더 좋은 답을 찾습니다.",
  hashtags: ["design", "agent"],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  // See apple-ui.spec.ts — an unseen release opens a click-blocking modal.
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

const TODAY = "2026-07-12";

function todo(id: string, title: string, extra: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    title,
    note: "",
    done: false,
    priority: "normal",
    dueDate: null,
    tags: [],
    source: "user",
    sourceConversationId: null,
    createdAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

const todoList: TodoListResponse = {
  todos: [
    todo("todo-1", "분기 실적 보고서 초안 검토", { dueDate: "2026-07-11" }),
    todo("todo-2", "고객사 미팅 자료 준비", { dueDate: TODAY, priority: "high" }),
    todo("todo-3", "신규 입사자 온보딩 문서 업데이트", { dueDate: "2026-07-15" }),
    todo("todo-4", "배포 서버 디스크 사용량 점검"),
    todo("todo-5", "보안 취약점 패치 적용 일정 잡기"),
  ],
  todayKst: TODAY,
  counts: { open: 5, overdue: 1, dueToday: 1, done: 0 },
};

// Long paragraphs so the transcript's text runs the full width of its column —
// right up to where the pinned card sits.
const LONG =
  "이번 분기 실적 보고서 초안을 검토하면서 확인해야 할 항목을 정리해 줘. 매출, 영업이익, 비용 구조 변화, 그리고 다음 분기 전망까지 각각 핵심 수치와 근거를 함께 적어 주면 좋겠어. 지난 분기와 비교해서 눈에 띄게 달라진 부분은 따로 강조해 줘.";
const messages = [0, 1, 2, 3].map((index) => ({
  id: `message-${index}`,
  conversationId: "conversation-1",
  role: index % 2 === 0 ? "user" : "assistant",
  content: index % 2 === 0 ? LONG : `정리했습니다. ${LONG}`,
  response: null,
  createdAt: `2026-07-12T03:0${index}:00.000Z`,
}));

const canvas = {
  id: "cv-metrics",
  title: "분기 지표",
  content: "## 분기 지표\n\n| 항목 | 값 |\n|---|---|\n| 매출 | 120 |\n| 영업이익 | 18 |",
  contentType: "markdown",
};

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/avatars/user-1") {
      body = {
        avatar: {
          ...user,
          hasImage: false,
          pluginCount: 0,
          visibility: "group",
          updatedAt: "2026-07-12T03:00:00.000Z",
          persona: "차분하고 정확한 디자인 동료",
          isOwn: true,
          elevated: true,
          plugins: [],
        },
      };
    } else if (path === "/api/conversations") {
      body = {
        conversations: [{
          id: "conversation-1",
          avatarUserId: "user-1",
          title: "분기 보고서 검토",
          avatarDisplayName: "진영",
          updatedAt: "2026-07-12T03:03:00.000Z",
          isRoutine: false,
          routineId: null,
          routinePrompt: null,
        }, {
          id: "conversation-2",
          avatarUserId: "user-1",
          title: "캔버스 대화",
          avatarDisplayName: "진영",
          updatedAt: "2026-07-12T02:00:00.000Z",
          isRoutine: false,
          routineId: null,
          routinePrompt: null,
        }],
      };
    } else if (path === "/api/messages") {
      // The canvas conversation opens the tabbed side panel next to the chat column.
      const canvases = new URL(route.request().url()).searchParams.get("conversationId") === "conversation-2" ? [canvas] : [];
      body = { messages, groupKnowledgeOff: [], canvases };
    } else if (path === "/api/me/todos") {
      body = todoList;
    } else if (path === "/api/chat/runs") {
      body = { run: null };
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

interface Box {
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Layout {
  card: Box;
  body: Box;
  composer: Box;
  head: Box;
  column: Box;
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const pane = document.querySelector(".chat-pane.active")!;
    const box = (element: Element | null): Box => {
      const rect = element!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      card: box(document.querySelector("#todo-overlay")),
      body: box(pane.querySelector(".chat-body")),
      composer: box(pane.querySelector(".composer")),
      head: box(pane.querySelector(".chat-head")),
      column: box(pane.querySelector(".transcript-inner")),
    };
  });
}

/** The card's surface: pinned is opaque with no backdrop blur; popover/sheet keep the frosted glass. */
async function surface(page: Page): Promise<{ backgroundColor: string; backdropFilter: string }> {
  return page.locator("#todo-overlay").evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, backdropFilter: style.backdropFilter };
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

/** The card sits inside the transcript region: below the header, above the composer, within the column. */
function expectInsideChatBody({ card, body, composer, head }: Layout): void {
  expect(card.width).toBeGreaterThan(0);
  expect(card.x).toBeGreaterThanOrEqual(body.x - 0.5);
  expect(card.right).toBeLessThanOrEqual(body.right + 0.5);
  expect(card.y).toBeGreaterThanOrEqual(body.y - 0.5);
  expect(card.bottom).toBeLessThanOrEqual(body.bottom + 0.5);
  expect(overlaps(card, composer)).toBe(false);
  expect(overlaps(card, head)).toBe(false);
}

/** Transcript text line boxes the card would paint over. */
async function transcriptTextUnderCard(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const card = document.querySelector("#todo-overlay")!.getBoundingClientRect();
    const inner = document.querySelector(".chat-pane.active .transcript-inner")!;
    const covered: string[] = [];
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.left < card.right && card.left < rect.right && rect.top < card.bottom && card.top < rect.bottom) {
          covered.push(text.slice(0, 40));
          break;
        }
      }
    }
    return covered;
  });
}

async function scrollTranscript(page: Page, to: "top" | "bottom"): Promise<void> {
  await page.evaluate((where) => {
    const transcript = document.querySelector(".chat-pane.active .transcript")!;
    transcript.scrollTo(0, where === "top" ? 0 : transcript.scrollHeight);
  }, to);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * Open the conversation from the rail (at desktop width — on a phone the rail is an
 * off-canvas drawer), size the window, then switch the card on from the composer
 * toggle (off by default).
 */
async function openCard(
  page: Page,
  viewport: { width: number; height: number },
  conversation = "분기 보고서 검토",
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.getByRole("button", { name: `대화 열기: ${conversation}` }).click();
  await expect(page.locator(".chat-pane.active .message.assistant")).toHaveCount(2);
  await page.setViewportSize(viewport);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const toggle = page.locator(".chat-pane.active .composer-todo-btn");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#todo-overlay")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#todo-overlay")).toBeVisible();
  await expect(page.locator("#todo-overlay .todo-overlay-item")).toHaveCount(5);
}

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

for (const viewport of [
  { width: 1680, height: 1000 },
  { width: 1300, height: 900 },
]) {
  test(`pinned card sits beside the transcript text on a ${viewport.width}px window`, async ({ page }) => {
    await openCard(page, viewport);
    const card = page.locator("#todo-overlay");
    await expect(card).toHaveAttribute("data-mode", "pinned");
    // Nothing behind a pinned card to frost: an opaque base, no backdrop blur.
    const pinnedSurface = await surface(page);
    expect(pinnedSurface.backdropFilter).toBe("none");
    expect(pinnedSurface.backgroundColor).toMatch(/^rgb\(/);

    for (const position of ["top", "bottom"] as const) {
      await scrollTranscript(page, position);
      const geometry = await layout(page);
      expect(geometry.body.width).toBeGreaterThanOrEqual(1000);
      expectInsideChatBody(geometry);
      expect(await transcriptTextUnderCard(page)).toEqual([]);
      // The reserve ends the text column just left of the card — a readable column,
      // no dead band in between (a 1000–1152px column narrows rather than squeezes).
      const gap = geometry.card.x - geometry.column.right;
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(24);
      expect(geometry.column.width).toBeGreaterThanOrEqual(640);
    }

    // Pinned is persistent: Escape inside it does not dismiss it.
    await page.locator("#todo-overlay .todo-overlay-input").focus();
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
  });
}

test("popover sits above the composer of a narrow column and Escape dismisses it from the card or the composer", async ({ page }) => {
  await openCard(page, { width: 1024, height: 768 });
  const card = page.locator("#todo-overlay");
  const toggle = page.locator(".chat-pane.active .composer-todo-btn");
  await expect(card).toHaveAttribute("data-mode", "popover");
  expect((await surface(page)).backdropFilter).toContain("blur(");

  const geometry = await layout(page);
  expect(geometry.body.width).toBeLessThan(1000);
  expectInsideChatBody(geometry);
  expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.composer.y);
  expect(Math.abs(geometry.body.right - geometry.card.right - 16)).toBeLessThanOrEqual(1);

  // Escape from inside the card: dismissed, focus back on the toggle.
  await page.locator("#todo-overlay .todo-overlay-input").focus();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeFocused();

  // Escape from the composer: dismissed too, and the caret stays in the composer.
  await toggle.click();
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // The toggle hands focus to the card's quick-add (after first paint); let that
  // land before moving the caret to the composer.
  await expect(page.locator("#todo-overlay .todo-overlay-input")).toBeFocused();
  const composer = page.locator(".chat-pane.active .composer textarea");
  await composer.focus();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(composer).toBeFocused();
});

test("sheet spans the chat column on a phone, above the composer, and Escape dismisses it", async ({ page }) => {
  await openCard(page, { width: 390, height: 844 });
  const card = page.locator("#todo-overlay");
  await expect(card).toHaveAttribute("data-mode", "sheet");
  expect((await surface(page)).backdropFilter).toContain("blur(");

  const geometry = await layout(page);
  expectInsideChatBody(geometry);
  expect(Math.abs(geometry.card.x - geometry.body.x - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.body.right - geometry.card.right - 8)).toBeLessThanOrEqual(1);
  expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.composer.y);

  await page.locator("#todo-overlay .todo-overlay-input").focus();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(page.locator(".chat-pane.active .composer-todo-btn")).toHaveAttribute("aria-pressed", "false");
});

test("an outside click only dismisses a transient card; the close button switches it off for good", async ({ page }) => {
  await openCard(page, { width: 1024, height: 768 });
  const card = page.locator("#todo-overlay");
  const toggle = page.locator(".chat-pane.active .composer-todo-btn");
  const stored = () => page.evaluate(() => localStorage.getItem("noah.todoOverlayOpen"));

  const body = (await layout(page)).body;
  await page.mouse.click(body.x + 40, body.y + 40);
  await expect(card).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBe("true");

  // The preference survived the dismissal: widening the column to pinned brings
  // the card back, and so does a reload on the wide layout.
  await page.setViewportSize({ width: 1680, height: 1000 });
  await expect(card).toHaveAttribute("data-mode", "pinned");
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Only the pinned card shows up on its own: a reload on a narrow layout keeps it
  // dismissed (no popover over the newest messages unasked)...
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload();
  await expect(page.locator(".chat-pane.active .composer textarea")).toBeVisible();
  await expect(card).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBe("true");
  // ...widening back to pinned brings it back without the toggle...
  await page.setViewportSize({ width: 1680, height: 1000 });
  await expect(card).toHaveAttribute("data-mode", "pinned");
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // ...and on the narrow layout the toggle shows it.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload();
  await expect(page.locator(".chat-pane.active .composer textarea")).toBeVisible();
  await expect(card).toBeHidden();
  await toggle.click();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-mode", "popover");

  // The × turns the preference off; a reload keeps it off.
  await page.getByRole("button", { name: "할 일 닫기", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBeNull();
  await page.reload();
  await expect(page.locator(".chat-pane.active .composer textarea")).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("with the side panel open the card stays in the narrowed chat column, left of the panel", async ({ page }) => {
  await openCard(page, { width: 1680, height: 1000 }, "캔버스 대화");
  const card = page.locator("#todo-overlay");
  const panel = page.locator("aside.canvas-panel");
  await expect(panel).toBeVisible();

  const expectBesidePanel = async (mode: "pinned" | "popover") => {
    await expect(card).toHaveAttribute("data-mode", mode);
    await expect(card).toBeVisible();
    const geometry = await layout(page);
    const side = await page.evaluate(() => {
      const box = (element: Element | null): Box | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        panel: box(document.querySelector("aside.canvas-panel"))!,
        tabs: box(document.querySelector("aside.canvas-panel .canvas-tabs")),
      };
    });
    // The pinned/popover decision follows the column the panel leaves.
    expect(geometry.body.width >= 1000).toBe(mode === "pinned");
    expectInsideChatBody(geometry);
    expect(geometry.card.right).toBeLessThanOrEqual(side.panel.x);
    if (side.tabs && side.tabs.width > 0) expect(overlaps(geometry.card, side.tabs)).toBe(false);
    if (mode === "pinned") expect(await transcriptTextUnderCard(page)).toEqual([]);
  };

  // 1680 − rail − the 440px panel leaves a 960px column: a popover beside the panel.
  await expectBesidePanel("popover");
  // Collapsing the panel to its 28px strip widens the column past 1000px: pinned.
  await panel.getByRole("button", { name: "패널 접기" }).click();
  await expectBesidePanel("pinned");
  // Expanded again, then a 1280px window: a 560px column, a popover again.
  await panel.getByRole("button", { name: /^패널 펼치기/ }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectBesidePanel("popover");
});

test("in split view a press on the other pane's toggle moves the card there; a second press switches it off", async ({ page }) => {
  await openCard(page, { width: 1680, height: 1000 });
  const card = page.locator("#todo-overlay");
  await expect(card).toHaveAttribute("data-mode", "pinned");
  await page.getByRole("button", { name: "대화 추가 (분할)" }).click();
  const panes = page.locator(".chat-pane");
  await expect(panes).toHaveCount(2);
  const toggles = [panes.nth(0).locator(".composer-todo-btn"), panes.nth(1).locator(".composer-todo-btn")];
  const stored = () => page.evaluate(() => localStorage.getItem("noah.todoOverlayOpen"));
  const expectShownIn = async (index: 0 | 1) => {
    await expect(panes.nth(index).locator("#todo-overlay")).toBeVisible();
    await expect(panes.nth(index)).toHaveClass(/\bactive\b/);
    // Pressed only in the pane that actually shows the card.
    await expect(toggles[index]).toHaveAttribute("aria-pressed", "true");
    await expect(toggles[1 - index]).toHaveAttribute("aria-pressed", "false");
    expect(await stored()).toBe("true");
  };

  // The new pane is active and its narrow column remounted the card dismissed;
  // its own toggle shows it there.
  await expect(panes.nth(1)).toHaveClass(/\bactive\b/);
  await expect(card).toBeHidden();
  await toggles[1].click();
  await expectShownIn(1);

  // Playwright's default (fast) click lands in the other pane's toggle before its
  // focusin-activated card has measured itself — the card must still move there.
  await toggles[0].click();
  await expectShownIn(0);

  // A second press on the pane showing it switches the card off.
  await toggles[0].click();
  await expect(card).toHaveCount(0);
  await expect(toggles[0]).toHaveAttribute("aria-pressed", "false");
  await expect(toggles[1]).toHaveAttribute("aria-pressed", "false");
  expect(await stored()).toBeNull();

  // Keyboard: on in pane 0, then Enter on pane 1's toggle moves it there. Focus
  // activates pane 1 (focusin) and remounts the card; like a real Tab → Enter, let
  // a frame pass so the remounted card has measured itself before the key lands.
  await toggles[0].click();
  await expectShownIn(0);
  await toggles[1].focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.keyboard.press("Enter");
  await expectShownIn(1);
});
