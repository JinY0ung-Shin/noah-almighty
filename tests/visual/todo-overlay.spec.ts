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
// layout brings back on its own. One case samples every animation frame while
// an avatar's mocked tool turn changes the list (jsdom has no layout, so the
// glide and the held-out leaving row are only real here).

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
  // The card reviews and completes; adding lives in the 할 일 tab (or the avatar).
  await expect(page.locator("#todo-overlay").getByRole("textbox")).toHaveCount(0);
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
    // A pinned card is a persistent side region Escape never closes: the toggle keeps focus.
    await expect(page.locator(".chat-pane.active .composer-todo-btn")).toBeFocused();
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
    await page.locator("#todo-overlay .todo-overlay-title").first().focus();
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

  // The toggle handed focus to the transient card itself (after first paint);
  // Escape from there: dismissed, focus back on the toggle.
  await expect(card).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeFocused();

  // Escape from the composer: dismissed too, and the caret stays in the composer.
  await toggle.click();
  await expect(card).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // Let the card take focus again before moving the caret to the composer.
  await expect(card).toBeFocused();
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

  // Escape from an item inside the card.
  await page.locator("#todo-overlay .todo-overlay-title").first().focus();
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

function sseFrames(frames: Array<{ event: string; data: unknown }>): string {
  return frames
    .map((frame, index) => `id: ${index + 1}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join("");
}

/** One animation frame of the card, recorded in the page while the list changes. */
interface MotionSample {
  /** The list's scrollable overflow (> 0 would flash a scrollbar in a card that does not scroll). */
  overflow: number;
  /** Rows held out of flow (`animate:` fixes a leaving row) — by title. */
  absolute: string[];
  /** Rows that are leaving — on their own or with their whole section (Svelte marks them `inert`) — by title. */
  leaving: string[];
  /** Rows with a running animation (glide, exit, arrival) — by title. */
  moving: string[];
  /** Rows marked as the avatar's additions — by title. */
  arrivals: string[];
  /**
   * Each row's y measured from the card's ANCHORED edge (the top of the pinned
   * card, the bottom of the popover/sheet), so the whole card moving with the
   * composer's height is not a row moving inside it — by title.
   */
  tops: Record<string, number>;
  /** The card's height (it changes when its list does — once, unless a height hold releases later). */
  height: number;
  /** Whether any row or section is still moving (running transform keyframes; not the card's own entrance). */
  cardMoving: boolean;
  /** Whether any running motion in the card or on the composer count moves something (transform keyframes). */
  transforms: boolean;
  /** The composer count's animation name. */
  pop: string;
}

async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __todoSamples: unknown[]; __todoSampling: boolean };
    state.__todoSamples = [];
    state.__todoSampling = true;
    const card = document.querySelector<HTMLElement>("#todo-overlay")!;
    const list = card.querySelector(".todo-overlay-body")!;
    const titleOf = (row: Element) => row.querySelector(".todo-overlay-title")?.textContent?.trim() ?? "";
    const moves = (animation: Animation) =>
      animation.playState === "running" &&
      ((animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []).some(
        (frame) => typeof frame.transform === "string" && frame.transform !== "none",
      );
    const step = () => {
      const rows = [...list.querySelectorAll<HTMLElement>("li.todo-overlay-item")];
      const count = document.querySelector(".chat-pane.active .composer-todo-count");
      const cardBox = card.getBoundingClientRect();
      const edge = card.dataset.mode === "pinned" ? cardBox.top : cardBox.bottom;
      const inCard = card.getAnimations({ subtree: true });
      state.__todoSamples.push({
        overflow: list.scrollHeight - list.clientHeight,
        absolute: rows.filter((row) => getComputedStyle(row).position === "absolute").map(titleOf),
        leaving: rows.filter((row) => row.inert || row.closest("[inert]") !== null).map(titleOf),
        moving: rows.filter((row) => row.getAnimations().some((animation) => animation.playState === "running")).map(titleOf),
        arrivals: rows.filter((row) => row.dataset.arrival === "added").map(titleOf),
        tops: Object.fromEntries(rows.map((row) => [titleOf(row), Math.round(row.getBoundingClientRect().top - edge)])),
        height: Math.round(cardBox.height),
        cardMoving: inCard.some((animation) => (animation.effect as KeyframeEffect | null)?.target !== card && moves(animation)),
        transforms: [...inCard, ...(count?.getAnimations() ?? [])].some(moves),
        pop: count ? getComputedStyle(count).animationName : "",
      });
      if (state.__todoSampling) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function stopSampling(page: Page): Promise<MotionSample[]> {
  return page.evaluate(() => {
    const state = window as unknown as { __todoSamples: MotionSample[]; __todoSampling: boolean };
    state.__todoSampling = false;
    return state.__todoSamples;
  });
}

/** Until nothing in the card is animating any more (the 1.2 s wash included). */
async function cardSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector("#todo-overlay")!
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
}

/**
 * Let the card settle, keep sampling half a second past that — beyond the 240 ms
 * height hold, so a late snap would be recorded — then collect the samples.
 */
async function settleAndCollect(page: Page): Promise<MotionSample[]> {
  await cardSettled(page);
  await page.waitForTimeout(500);
  return stopSampling(page);
}

/** Whether the rows differ: another set, or one sitting more than 1 px elsewhere (rounding noise is no move). */
function rowsMoved(a: MotionSample, b: MotionSample): boolean {
  const titles = Object.keys(a.tops);
  if (titles.length !== Object.keys(b.tops).length) return true;
  return titles.some((title) => !(title in b.tops) || Math.abs(a.tops[title] - b.tops[title]) > 1);
}

function maxOverflow(samples: MotionSample[]): number {
  return Math.max(...samples.map((sample) => sample.overflow));
}

/**
 * Once the change has landed (the final rows are all there) and nothing in the
 * card moves any more, no row's y may change again — e.g. a height hold
 * releasing late in a bottom-anchored card would snap every row back. With
 * `cardHeight` (where no hold belongs: the popover, reduced motion) the card
 * resizes at most once, in the very frame its rows change — a hold resizes it
 * later, a second jump.
 */
function expectNoLateMoves(samples: MotionSample[], options: { cardHeight?: boolean } = {}): void {
  if (options.cardHeight) {
    // The frame the change lands: a row starts leaving (Svelte marks it `inert` in
    // the same flush that resizes the card) or — an instant change — the rows
    // differ. Glides hold rows in place on that frame, so tops alone can lag it.
    const landed = samples.findIndex((sample) => sample.leaving.length > 0 || rowsMoved(sample, samples[0]));
    const resizes = samples.flatMap((sample, index) =>
      index > 0 && Math.abs(sample.height - samples[index - 1].height) > 1 ? [index] : [],
    );
    expect(landed).toBeGreaterThan(0);
    expect(resizes.length).toBeLessThanOrEqual(1);
    if (resizes.length) expect(resizes[0]).toBe(landed);
  }
  const key = (sample: MotionSample) => Object.keys(sample.tops).sort().join("|");
  const finalRows = key(samples[samples.length - 1]);
  let start = samples.findIndex((sample) => key(sample) === finalRows);
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].cardMoving) {
      start = Math.max(start, index + 1);
      break;
    }
  }
  const settled = samples.slice(start);
  // Sampled well past the 240 ms height hold (settleAndCollect).
  expect(settled.length).toBeGreaterThan(20);
  for (const sample of settled) {
    expect(rowsMoved(sample, settled[0]), `${JSON.stringify(sample.tops)} vs ${JSON.stringify(settled[0].tops)}`).toBe(false);
  }
}

/** A leaving row leaves from where it was: while it leaves its y stays put (±2 px). */
function expectLeavesInPlace(samples: MotionSample[], title: string): void {
  const before = samples[0].tops[title];
  const during = samples.filter((sample) => sample.leaving.includes(title)).map((sample) => sample.tops[title]);
  expect(during.length).toBeGreaterThan(0);
  for (const top of during) expect(Math.abs(top - before), `${title}: y ${top}, was ${before}`).toBeLessThanOrEqual(2);
}

/**
 * Serves the to-do list the avatar's tools change and one SSE turn per message:
 * `open`, the turn's to-do tool calls (all started, then all ended — parallel
 * calls that one re-read answers), `done`. Each turn first applies its queued
 * server-side change. Registered after mockApp's catch-all, so these routes
 * answer first.
 */
async function mockAvatarTurns(page: Page) {
  let list: TodoItem[] = todoList.todos.map((item) => ({ ...item }));
  const counts = () => {
    const open = list.filter((item) => !item.done);
    return {
      open: open.length,
      overdue: open.filter((item) => item.dueDate !== null && item.dueDate < TODAY).length,
      dueToday: open.filter((item) => item.dueDate === TODAY).length,
      done: list.length - open.length,
    };
  };
  const complete = (id: string) =>
    (list = list.map((item) =>
      item.id === id ? { ...item, done: true, completedAt: "2026-07-12T04:00:00.000Z", updatedAt: "2026-07-12T04:00:00.000Z" } : item,
    ));
  const avatarTurns: Array<{ change: () => void; tools: number }> = [];
  let turn = 0;
  await page.route("**/api/me/todos", (route) => route.fulfill({ json: { todos: list, todayKst: TODAY, counts: counts() } }));
  await page.route("**/api/me/todos/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const patch = route.request().postDataJSON() as { done?: boolean };
    if (patch.done) complete(id);
    await route.fulfill({ json: { todo: list.find((item) => item.id === id), todayKst: TODAY, counts: counts() } });
  });
  await page.route("**/api/chat/stream", async (route) => {
    turn += 1;
    const next = avatarTurns.shift();
    next?.change(); // what the avatar's to-do tools did
    const ids = Array.from({ length: next?.tools ?? 1 }, (_, index) => `tu-todo-${turn}-${index}`);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseFrames([
        { event: "open", data: { conversationId: "conversation-1", runId: `run-todo-${turn}` } },
        ...ids.map((toolUseId) => ({ event: "tool", data: { toolUseId, name: "mcp__todo__update_todo", input: {} } })),
        ...ids.map((toolUseId) => ({ event: "tool_end", data: { toolUseId, ok: true } })),
        {
          event: "done",
          data: {
            message: {
              id: `answer-${turn}`,
              conversationId: "conversation-1",
              role: "assistant",
              content: "할 일을 정리했습니다.",
              response: null,
              createdAt: "2026-07-12T04:00:00.000Z",
            },
          },
        },
      ]),
    });
  });
  return {
    complete,
    add: (item: TodoItem) => (list = [...list, item]),
    /** Queue what the avatar's tools do on the next message's turn (`tools` parallel calls). */
    nextTurn: (change: () => void, tools = 1) => avatarTurns.push({ change, tools }),
  };
}

/** Send from the composer with Enter — a click on the send button would be an outside press that dismisses a popover. */
async function sendWithEnter(page: Page, text: string): Promise<void> {
  const composer = page.locator(".chat-pane.active .composer textarea");
  await composer.fill(text);
  await composer.press("Enter");
}

test("an avatar's change moves rows inside the card; the viewer's own checkbox moves none; reduced motion only fades", async ({ page }) => {
  const server = await mockAvatarTurns(page);
  const rows = page.locator("#todo-overlay .todo-overlay-item");

  // 1) Motion on, pinned (top-anchored): the avatar completes the first of 다음's three rows.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openCard(page, { width: 1680, height: 1000 });
  await expect(page.locator("#todo-overlay")).toHaveAttribute("data-mode", "pinned");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
  server.nextTurn(() => server.complete("todo-3"));
  await startSampling(page);
  await sendWithEnter(page, "온보딩 문서는 끝났어");
  await expect(rows).toHaveCount(4);
  let samples = await settleAndCollect(page);
  // The leaving row was held out of flow inside the list while the rows below glided up…
  expect(samples.some((sample) => sample.absolute.includes("신규 입사자 온보딩 문서 업데이트"))).toBe(true);
  expectLeavesInPlace(samples, "신규 입사자 온보딩 문서 업데이트");
  expect(samples.some((sample) => sample.moving.includes("배포 서버 디스크 사용량 점검"))).toBe(true);
  expect(samples.some((sample) => sample.moving.includes("보안 취약점 패치 적용 일정 잡기"))).toBe(true);
  // …without ever overflowing the card or moving again once settled, and the composer count popped.
  expect(maxOverflow(samples)).toBeLessThanOrEqual(0);
  expectNoLateMoves(samples);
  expect(samples.some((sample) => sample.pop === "todo-count-pop")).toBe(true);

  // 2) The viewer's own checkbox: the row leaves at once, nothing glides, nothing pops.
  await expect(page.locator(".chat-pane.active .composer-todo-count.is-popping")).toHaveCount(0); // the avatar's pop has expired
  await startSampling(page);
  await page.locator("#todo-overlay").getByRole("checkbox", { name: "완료: 배포 서버 디스크 사용량 점검" }).click();
  await expect(rows).toHaveCount(3);
  await page.waitForTimeout(400);
  samples = await stopSampling(page);
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.every((sample) => sample.moving.length === 0 && sample.absolute.length === 0)).toBe(true);
  expect(samples.every((sample) => sample.pop !== "todo-count-pop")).toBe(true);
  expect(maxOverflow(samples)).toBeLessThanOrEqual(0);

  // 3) Reduced motion: the avatar completes 다음's last row and adds one for today —
  // the exit is instant, the arrival only fades (and washes), nothing pops, and
  // the layout changes once (no held height to release later).
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  server.nextTurn(() => {
    server.complete("todo-5");
    server.add(todo("todo-6", "아바타가 넣은 회의 준비", { dueDate: TODAY, source: "avatar" }));
  });
  await startSampling(page);
  await sendWithEnter(page, "회의 준비도 넣어줘");
  await expect(page.locator("#todo-overlay").getByText("아바타가 넣은 회의 준비")).toBeVisible();
  await expect(page.locator("#todo-overlay").getByText("보안 취약점 패치 적용 일정 잡기")).toHaveCount(0);
  samples = await settleAndCollect(page);
  expect(samples.some((sample) => sample.arrivals.includes("아바타가 넣은 회의 준비"))).toBe(true);
  expect(samples.some((sample) => sample.transforms)).toBe(false);
  expect(samples.some((sample) => sample.absolute.length > 0)).toBe(false);
  expect(samples.some((sample) => sample.pop === "todo-count-pop")).toBe(false);
  expect(maxOverflow(samples)).toBeLessThanOrEqual(0);
  expectNoLateMoves(samples, { cardHeight: true });
});

test("in the bottom-anchored popover an avatar's change settles once: no row moves after its motion", async ({ page }) => {
  const server = await mockAvatarTurns(page);
  const card = page.locator("#todo-overlay");
  const rows = page.locator("#todo-overlay .todo-overlay-item");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openCard(page, { width: 1024, height: 768 });
  await expect(card).toHaveAttribute("data-mode", "popover");

  // The avatar completes the middle of 다음's three rows: the card shrinks from
  // its top, the rows above glide down, the row below stays where it is.
  server.nextTurn(() => server.complete("todo-4"));
  await startSampling(page);
  await sendWithEnter(page, "디스크 점검은 끝났어");
  await expect(rows).toHaveCount(4);
  const samples = await settleAndCollect(page);
  await expect(card).toBeVisible(); // still shown: sending never dismissed it
  expect(samples.some((sample) => sample.absolute.includes("배포 서버 디스크 사용량 점검"))).toBe(true);
  // The rows above glide down while the leaving row's own section moves with them — it still leaves in place.
  expectLeavesInPlace(samples, "배포 서버 디스크 사용량 점검");
  expect(samples.some((sample) => sample.moving.length > 0)).toBe(true);
  expect(maxOverflow(samples)).toBeLessThanOrEqual(0);
  expectNoLateMoves(samples, { cardHeight: true });

  // The lone 오늘 row: its whole section leaves (held by a static offset, no glide).
  server.nextTurn(() => server.complete("todo-2"));
  await startSampling(page);
  await sendWithEnter(page, "미팅 자료도 끝났어");
  await expect(rows).toHaveCount(3);
  let more = await settleAndCollect(page);
  expectLeavesInPlace(more, "고객사 미팅 자료 준비");
  expect(maxOverflow(more)).toBeLessThanOrEqual(0);
  expectNoLateMoves(more, { cardHeight: true });

  // Two parallel tool calls, one re-read: an overdue item lands at the top while
  // 다음's last row is completed — the leaving row still leaves from where it was.
  server.nextTurn(() => {
    server.add(todo("todo-7", "새로 생긴 급한 일", { dueDate: "2026-07-10", source: "avatar" }));
    server.complete("todo-5");
  }, 2);
  await startSampling(page);
  await sendWithEnter(page, "급한 일 넣고 보안 패치 일정도 잡았어");
  await expect(page.locator("#todo-overlay").getByText("새로 생긴 급한 일")).toBeVisible();
  await expect(page.locator("#todo-overlay").getByText("보안 취약점 패치 적용 일정 잡기")).toHaveCount(0);
  more = await settleAndCollect(page);
  expectLeavesInPlace(more, "보안 취약점 패치 적용 일정 잡기");
  expect(maxOverflow(more)).toBeLessThanOrEqual(0);
  expectNoLateMoves(more);
});

test("with a parallel addition above, the pinned card's leaving row still leaves from where it was", async ({ page }) => {
  const server = await mockAvatarTurns(page);
  const rows = page.locator("#todo-overlay .todo-overlay-item");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openCard(page, { width: 1680, height: 1000 });
  await expect(page.locator("#todo-overlay")).toHaveAttribute("data-mode", "pinned");
  // Two parallel tool calls, one re-read: an overdue item lands at the top (every
  // row below shifts down before Svelte measures the leaving one) while 다음's
  // first row is completed.
  server.nextTurn(() => {
    server.add(todo("todo-7", "새로 생긴 급한 일", { dueDate: "2026-07-10", source: "avatar" }));
    server.complete("todo-3");
  }, 2);
  await startSampling(page);
  await sendWithEnter(page, "급한 일 넣고 온보딩 문서는 끝났어");
  await expect(page.locator("#todo-overlay").getByText("새로 생긴 급한 일")).toBeVisible();
  await expect(rows).toHaveCount(5);
  const samples = await settleAndCollect(page);
  expectLeavesInPlace(samples, "신규 입사자 온보딩 문서 업데이트");
  expect(maxOverflow(samples)).toBeLessThanOrEqual(0);
  expectNoLateMoves(samples);
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
