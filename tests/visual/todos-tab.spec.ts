import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";
import { isOpenTodo, type TodoItem, type TodoStatus } from "../../src/shared/todos.js";

// The 할 일 tab (TodosView.svelte): geometry facts, no screenshots. The editor's
// 상태 control — four segments in the editor's fixed measure, down to its 300px
// floor — stays on one row inside the pane at desktop, laptop, stacked and phone
// widths (and in the dark theme); the page never scrolls sideways; the seven filter
// chips wrap inside their row. The 진행 중 tag differs from the 오늘 chip in FORM
// (a leading dot), not just hue — the light theme's info and accent blues are
// nearly one colour. And in a real browser the control is manual-activation:
// arrows only move focus, Enter or Space applies, one PATCH per pick (jsdom has no
// key-triggered button activation, so only this suite can show it).

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
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
    status: "todo",
    priority: "normal",
    dueDate: null,
    tags: [],
    source: "user",
    sourceConversationId: null,
    createdAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    closedAt: null,
    ...extra,
  };
}

function initialTodos(): TodoItem[] {
  return [
    todo("todo-1", "분기 실적 보고서 초안 검토", { status: "in_progress", dueDate: "2026-07-11", tags: ["보고"] }),
    todo("todo-2", "고객사 미팅 자료 준비", { status: "in_progress", priority: "high" }),
    todo("todo-3", "신규 입사자 온보딩 문서 업데이트", { dueDate: "2026-07-15" }),
    todo("todo-4", "배포 서버 디스크 사용량 점검", { dueDate: TODAY }),
    todo("todo-5", "보안 취약점 패치 적용 일정 잡기", { source: "avatar" }),
    todo("todo-6", "지난주 회의록 공유", { status: "done", closedAt: "2026-07-11T03:00:00.000Z" }),
    todo("todo-7", "옛 기획안 검토", { status: "dropped", closedAt: "2026-07-11T04:00:00.000Z", dueDate: "2026-07-01" }),
  ];
}

/** The app booted logged-in, with a stateful /api/me/todos; returns the PATCH bodies it received. */
async function mockApp(page: Page): Promise<{ patches: { id: string; body: { status?: TodoStatus } }[] }> {
  const list = initialTodos();
  const patches: { id: string; body: { status?: TodoStatus } }[] = [];
  const snapshot = () => {
    const open = list.filter(isOpenTodo);
    return {
      todayKst: TODAY,
      counts: {
        open: open.length,
        inProgress: open.filter((item) => item.status === "in_progress").length,
        overdue: open.filter((item) => item.dueDate !== null && item.dueDate < TODAY).length,
        dueToday: open.filter((item) => item.dueDate === TODAY).length,
        done: list.filter((item) => item.status === "done").length,
        dropped: list.filter((item) => item.status === "dropped").length,
      },
    };
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path === "/api/me/todos") {
      body = { todos: list, ...snapshot() };
    } else if (path.startsWith("/api/me/todos/") && route.request().method() === "PATCH") {
      const id = decodeURIComponent(path.split("/").pop() ?? "");
      const patch = route.request().postDataJSON() as { status?: TodoStatus };
      patches.push({ id, body: patch });
      const index = list.findIndex((item) => item.id === id);
      const status = patch.status ?? list[index].status;
      list[index] = {
        ...list[index],
        status,
        closedAt: isOpenTodo({ status }) ? null : "2026-07-12T05:00:00.000Z",
        updatedAt: "2026-07-12T05:00:00.000Z",
      };
      body = { todo: list[index], ...snapshot() };
    } else if (path.endsWith("/knowledge/requests")) {
      body = { requests: [] };
    } else if (path.endsWith("/notifications")) {
      body = { notifications: [] };
    } else if (path.endsWith("/plugins")) {
      body = { plugins: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { patches };
}

async function waitForKoreanFont(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const visibleText = document.body.innerText;
    const faces = await Promise.all([400, 600, 700].map((weight) =>
      document.fonts.load(`${weight} 14px "Noto Sans KR Variable"`, visibleText)
    ));
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.fonts.status === "loaded" && faces.every((loaded) => loaded.length > 0);
  })).toBe(true);
  await assertNoFallbackHangul(page);
}

/**
 * `document.fonts` can report every face loaded while a text node still RENDERS
 * with the system fallback — on this Korean-font-less box that is a row of tofu
 * boxes, whose widths would make every fit below meaningless. Same probe as
 * apple-ui.spec.ts / skills.spec.ts (see there): ask the renderer which platform
 * font each Hangul-bearing node used, and fail loudly on a fallback.
 */
async function assertNoFallbackHangul(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hangul = /[ㄱ-ㆎ가-힣]/;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      if (!hangul.test(own)) continue;
      const rect = element.getBoundingClientRect();
      // Never painted (the skip link parks at translateY(-200%)).
      if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0) continue;
      // Collapsible whitespace runs become one space glyph; under pre/pre-wrap every
      // whitespace character is its own glyph. Everything else non-Hangul is one glyph.
      // Unlike a block's, an INLINE element's edge space sits mid-line next to its
      // neighbours' text and is painted (the header's " · 마감 지남 1개"), so it is kept.
      const style = getComputedStyle(element);
      const preserved = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
      const text = element.textContent ?? "";
      const collapsed = text.replace(/\s+/g, " ");
      const counted = preserved ? text : style.display === "inline" ? collapsed : collapsed.trim();
      const nonHangul = [...counted].filter((ch) => !hangul.test(ch)).length;
      element.setAttribute("data-hangul-probe", String(nonHangul));
    }
  });
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-hangul-probe]" });
    const offenders: string[] = [];
    for (const nodeId of nodeIds) {
      const { node } = await client.send("DOM.describeNode", { nodeId, depth: 1 });
      const attributes = node.attributes ?? [];
      const nonHangul = Number(attributes[attributes.indexOf("data-hangul-probe") + 1] ?? 0);
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      const systemGlyphs = fonts.filter((font) => !font.isCustomFont).reduce((sum, font) => sum + font.glyphCount, 0);
      if (systemGlyphs > nonHangul) {
        const text = (node.children ?? []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join("");
        offenders.push(`<${node.localName}> "${text.trim().slice(0, 24)}" → ${fonts.map((font) => `${font.familyName}×${font.glyphCount}`).join(", ")} (non-Hangul chars ${nonHangul})`);
      }
    }
    expect(offenders, "Hangul rendered with a system fallback font (tofu) — see assertNoFallbackHangul").toEqual([]);
  } finally {
    await client.detach();
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("[data-hangul-probe]")) element.removeAttribute("data-hangul-probe");
    });
  }
}

/** Open the tab deep-linked to one item, so its editor is showing. */
async function openTab(page: Page, viewport: { width: number; height: number }, id = "todo-1"): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/#/todos/${id}`);
  await expect(page.getByRole("heading", { name: "할 일", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "상태", exact: true })).toBeVisible();
  await waitForKoreanFont(page);
}

interface TabLayout {
  viewport: number;
  pageScrollWidth: number;
  /** The editor pane's content box (inside its padding). */
  editor: { left: number; right: number; scrollWidth: number; clientWidth: number };
  /** The 상태 segments: their box, and whether any label is clipped. */
  segments: { text: string; left: number; right: number; top: number; clipped: boolean }[];
  chips: { scrollWidth: number; clientWidth: number; left: number; right: number; items: { text: string; left: number; right: number }[] };
}

async function tabLayout(page: Page): Promise<TabLayout> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".todo-detail-pane")!;
    const paneBox = pane.getBoundingClientRect();
    const paneStyle = getComputedStyle(pane);
    const chips = document.querySelector<HTMLElement>(".todos-body .routine-filter-chips")!;
    const chipsBox = chips.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      editor: {
        left: paneBox.left + Number.parseFloat(paneStyle.paddingLeft),
        right: paneBox.right - Number.parseFloat(paneStyle.paddingRight),
        scrollWidth: pane.scrollWidth,
        clientWidth: pane.clientWidth,
      },
      segments: [...document.querySelectorAll<HTMLButtonElement>(".todo-status-control .seg-btn")].map((button) => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent ?? "", left: box.left, right: box.right, top: box.top, clipped: button.scrollWidth > button.clientWidth };
      }),
      chips: {
        scrollWidth: chips.scrollWidth,
        clientWidth: chips.clientWidth,
        left: chipsBox.left,
        right: chipsBox.right,
        items: [...chips.querySelectorAll<HTMLElement>(".routine-chip")].map((chip) => {
          const box = chip.getBoundingClientRect();
          return { text: chip.getAttribute("aria-label") ?? "", left: box.left, right: box.right };
        }),
      },
    };
  });
}

function expectTabFits(layout: TabLayout): void {
  // No sideways page scroll.
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewport);
  // The 상태 control: four unclipped segments on ONE row, inside the editor's content box.
  expect(layout.segments.map((segment) => segment.text)).toEqual(["시작 전", "진행 중", "완료", "드랍"]);
  expect(layout.segments.some((segment) => segment.clipped)).toBe(false);
  const tops = layout.segments.map((segment) => segment.top);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  expect(Math.min(...layout.segments.map((segment) => segment.left))).toBeGreaterThanOrEqual(layout.editor.left - 0.5);
  expect(Math.max(...layout.segments.map((segment) => segment.right))).toBeLessThanOrEqual(layout.editor.right + 0.5);
  expect(layout.editor.scrollWidth).toBeLessThanOrEqual(layout.editor.clientWidth);
  // The seven filter chips wrap inside their row: none past its edges, no overflow.
  expect(layout.chips.items.map((chip) => chip.text)).toEqual(["오늘 2", "예정 1", "마감 지남 1", "진행 중 2", "전체 5", "완료 1", "드랍 1"]);
  expect(layout.chips.scrollWidth).toBeLessThanOrEqual(layout.chips.clientWidth);
  for (const chip of layout.chips.items) {
    expect(chip.left, chip.text).toBeGreaterThanOrEqual(layout.chips.left - 0.5);
    expect(chip.right, chip.text).toBeLessThanOrEqual(layout.chips.right + 0.5);
  }
}

for (const viewport of [
  { width: 1440, height: 900 },
  // The editor at its 300px floor beside the list.
  { width: 1100, height: 820 },
  { width: 1000, height: 820 },
  // Stacked (≤980px): the editor under the list, then a phone.
  { width: 900, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`the 상태 control fits on one row in the editor at ${viewport.width}px; the chips wrap; no sideways scroll`, async ({ page }) => {
    await mockApp(page);
    await openTab(page, viewport);
    expectTabFits(await tabLayout(page));
  });
}

test("in the dark theme the control still fits and its pressed segment stands out", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApp(page);
  await openTab(page, { width: 1100, height: 820 });
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  expectTabFits(await tabLayout(page));
  const fills = await page.locator(".todo-status-control .seg-btn").evaluateAll((buttons) =>
    buttons.map((button) => ({ pressed: button.getAttribute("aria-pressed") === "true", fill: getComputedStyle(button).backgroundColor })),
  );
  const pressed = fills.filter((segment) => segment.pressed);
  expect(pressed).toHaveLength(1);
  for (const other of fills.filter((segment) => !segment.pressed)) expect(other.fill).not.toBe(pressed[0].fill);
});

test("the 진행 중 tag differs from the 오늘 chip in form, not just hue", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await mockApp(page);
    await openTab(page, { width: 1440, height: 900 });
    const marks = await page.evaluate(() => {
      const dot = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const before = getComputedStyle(element, "::before");
        return { content: before.content, width: before.width };
      };
      return { inProgress: dot(".tag.todo-status"), today: dot('.tag.todo-due[data-bucket="today"]') };
    });
    expect(marks.inProgress, scheme).toEqual({ content: '""', width: "6px" });
    expect(marks.today?.content, scheme).toBe("none");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("the 상태 control activates manually: arrows only move focus, Enter or Space applies — one PATCH per pick", async ({ page }) => {
  const server = await mockApp(page);
  await openTab(page, { width: 1440, height: 900 }, "todo-3");
  const control = page.getByRole("group", { name: "상태", exact: true });
  const segment = (name: string) => control.getByRole("button", { name, exact: true });
  await expect(segment("시작 전")).toHaveAttribute("aria-pressed", "true");

  // Tab lands on the current status; the arrows and Home/End move focus only.
  await segment("시작 전").focus();
  for (const [key, lands] of [
    ["ArrowRight", "진행 중"],
    ["ArrowRight", "완료"],
    ["End", "드랍"],
    ["ArrowRight", "시작 전"],
    ["ArrowLeft", "드랍"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(segment(lands)).toBeFocused();
  }
  await expect(segment("시작 전")).toHaveAttribute("aria-pressed", "true");
  expect(server.patches).toEqual([]);

  // Enter on the focused 드랍: 시작 전 → 드랍 in ONE write.
  await page.keyboard.press("Enter");
  await expect(segment("드랍")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => server.patches.length).toBe(1);
  await expect(control).not.toHaveAttribute("aria-busy", "true");
  // Space on 완료.
  await page.keyboard.press("ArrowLeft");
  await expect(segment("완료")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(segment("완료")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => server.patches.length).toBe(2);
  await page.waitForTimeout(200);
  expect(server.patches).toEqual([
    { id: "todo-3", body: { status: "dropped" } },
    { id: "todo-3", body: { status: "done" } },
  ]);
});
