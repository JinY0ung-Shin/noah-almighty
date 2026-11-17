import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Canvas content never styles the app. An `html` canvas is a PAGE in its own
// sandboxed frame: its LEADING <style> (the one a body-only sanitize used to drop)
// must style it, and the frame must fit the page. An svg/mermaid canvas is a
// drawing in its own shadow root: its <style> styles the drawing only, and sizing
// and export work as before. Real layout, a real sandbox and real SVG styling —
// jsdom can check none of them.

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

// Every rule but the last two would visibly break the app if it leaked out of the frame.
const CARD_PAGE = `<style>
  :root { --brand: rgb(1, 2, 3); }
  * { margin: 0; padding: 0; }
  body { background: rgb(9, 9, 9); }
  .canvas-panel { visibility: hidden; }
  .card { height: 120px; background: var(--brand); color: white; }
  .more { height: 200px; }
</style>
<div class="card">카드</div>
<details><summary>더보기</summary><div class="more"></div></details>`;

// Fills its viewport and scrolls its own pane: no natural height to fit to.
const SHELL_PAGE = `<!DOCTYPE html><html><head><style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: 40px 1fr; }
  main { overflow: auto; }
</style></head><body><header>앱</header><main>${"<p>행</p>".repeat(80)}</main></body></html>`;

// Inside-the-svg AND after-the-svg <style>s, both of which used to restyle the app.
const SHAPE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="400" viewBox="0 0 2000 400">
  <style>.shape { fill: rgb(1, 2, 3); } .canvas-panel { visibility: hidden; }</style>
  <rect class="shape" width="2000" height="400"/>
</svg>
<style>body { background: rgb(9, 9, 9); }</style>`;

const FLOW_MERMAID = "flowchart LR\n  A[시작] --> B[끝]";

const BAR_VEGA = JSON.stringify({
  data: { values: [{ k: "A", v: 3 }, { k: "B", v: 5 }] },
  mark: "bar",
  encoding: { x: { field: "k", type: "nominal" }, y: { field: "v", type: "quantitative" } },
});

// The diagram types that put their labels in <foreignObject> HTML by default — the
// svg-profile sanitize strips it, and each drew empty boxes until `htmlLabels: false`.
const LABELED_MERMAID: Array<[title: string, source: string, label: string]> = [
  ["순서도", "flowchart LR\n  A[시작] --> B[끝]", "시작"],
  ["클래스", "classDiagram\n  class 주문 {\n    +번호\n  }\n  주문 --> 고객", "주문"],
  ["상태", "stateDiagram-v2\n  [*] --> 대기\n  대기 --> 완료", "대기"],
  ["ER", "erDiagram\n  고객 ||--o{ 주문 : 한다", "고객"],
  ["마인드맵", "mindmap\n  root((중심))\n    가지하나", "가지하나"],
  ["칸반", "kanban\n  todo[할일목록]\n    t1[작업하나]", "작업하나"],
];

type CanvasFixture = { id: string; title: string; content: string; contentType: string };

// The LAST canvas opens active.
async function mockApp(page: Page, canvases: CanvasFixture[]): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: Record<string, unknown> = {};
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
          persona: "",
          isOwn: true,
          elevated: true,
          plugins: [],
        },
      };
    } else if (path === "/api/conversations") {
      body = {
        conversations: [
          {
            id: "c-html",
            avatarUserId: "user-1",
            title: "목업 대화",
            avatarDisplayName: "진영",
            updatedAt: "2026-10-06T03:00:00.000Z",
            isRoutine: false,
            routineId: null,
            routinePrompt: null,
          },
        ],
      };
    } else if (path === "/api/messages") {
      body = {
        messages: [
          {
            id: "m-1",
            conversationId: "c-html",
            role: "user",
            content: "목업 보여줘",
            response: null,
            createdAt: "2026-10-06T03:00:00.000Z",
          },
        ],
        canvases,
      };
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

test("an html canvas renders as its own page: styled, contained and fitted", async ({ page }) => {
  await mockApp(page, [
    { id: "cv-shell", title: "앱 셸", content: SHELL_PAGE, contentType: "html" },
    { id: "cv-card", title: "카드", content: CARD_PAGE, contentType: "html" },
  ]);
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 목업 대화" }).click();

  const panel = page.locator(".canvas-panel");
  const frame = panel.locator("iframe.canvas-html-frame");
  const inPanel = page.frameLocator(".canvas-panel iframe.canvas-html-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");

  // 1. The page RENDERS: actionability waits on the frame's own animation frames, so a
  //    render-blocked page (a stylesheet that never arrives) fails here...
  await inPanel.locator(".card").hover();
  // ...its leading <style> survived — `:root` variable included — inside the frame...
  await expect(inPanel.locator(".card")).toHaveText("카드");
  await expect(inPanel.locator(".card")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await expect(inPanel.locator("body")).toHaveCSS("background-color", "rgb(9, 9, 9)");
  // ...and reached nothing outside it.
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(9, 9, 9)");

  // 2. The frame shrank from its 60vh viewport (432px) to the page...
  const pageHeight = () => inPanel.locator("html").evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
  const frameHeight = async () => (await frame.boundingBox())?.height;
  await expect.poll(frameHeight).toBe(await pageHeight());
  expect(await frameHeight()).toBeLessThan(432);
  // ...and follows it when the page changes itself (an opened <details>).
  const closed = await pageHeight();
  await inPanel.locator("summary").click();
  await expect.poll(frameHeight).toBe(closed + 200);

  // 3. A page that fills its viewport keeps the frame's CSS height (60vh of 720).
  await page.getByRole("tab", { name: "앱 셸" }).click();
  await expect(inPanel.locator("header")).toHaveText("앱");
  await expect.poll(frameHeight).toBe(432);

  // 4. Fullscreen: Escape pressed INSIDE the page still closes it...
  await page.getByRole("button", { name: "전체화면" }).click();
  const inFullscreen = page.frameLocator(".canvas-fs iframe.canvas-html-frame");
  await inFullscreen.locator("header").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-fs")).toHaveCount(0);

  // ...and the wheel over the page still zooms.
  await page.getByRole("button", { name: "전체화면" }).click();
  await page.locator(".canvas-fs iframe.canvas-html-frame").hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator(".canvas-fs-zoom")).toContainText("115%");

  // A zoom that reflows: the frame still fills the stage exactly (nothing is pushed
  // out of reach), and the page inside is laid out in a viewport 1/zoom as wide.
  await page.getByRole("button", { name: "확대" }).click();
  await page.getByRole("button", { name: "확대" }).click();
  await expect(page.locator(".canvas-fs-zoom")).toContainText("155%");
  const framed = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".canvas-fs-stage")!;
    const frame = document.querySelector<HTMLIFrameElement>(".canvas-fs iframe.canvas-html-frame")!;
    const style = getComputedStyle(stage);
    const inner = stage.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    return {
      left: Math.round(box.left - inner.left - Number.parseFloat(style.paddingLeft)),
      slack: Math.round(inner.right - Number.parseFloat(style.paddingRight) - box.right),
      overflowX: stage.scrollWidth - stage.clientWidth,
      viewport: frame.clientWidth / box.width,
    };
  });
  expect(framed.left).toBe(0);
  expect(Math.abs(framed.slack)).toBeLessThanOrEqual(1);
  expect(framed.overflowX).toBeLessThanOrEqual(1);
  expect(framed.viewport).toBeCloseTo(1 / 1.55, 2);
});

test("an svg canvas draws in its own shadow root: styled, contained, sized and exportable", async ({ page }) => {
  await mockApp(page, [
    { id: "cv-bar", title: "막대", content: BAR_VEGA, contentType: "vega" },
    { id: "cv-flow", title: "흐름", content: FLOW_MERMAID, contentType: "mermaid" },
    { id: "cv-shape", title: "도형", content: SHAPE_SVG, contentType: "svg" },
  ]);
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 목업 대화" }).click();

  // 1. The drawing's own <style> styles it (CSS selectors pierce open shadow roots)...
  const panel = page.locator(".canvas-panel");
  const shape = panel.locator(".canvas-svg .shape");
  await expect(shape).toHaveCSS("fill", "rgb(1, 2, 3)");
  // ...and neither <style> reached the app.
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(9, 9, 9)");

  // 2. The panel still fits the drawing to its width.
  const width = (selector: string) =>
    page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const hostWidth = await panel.locator(".canvas-svg").evaluate((el) => el.clientWidth);
  expect(await width(".canvas-panel .canvas-svg svg")).toBe(hostWidth);

  // 3. Export reads the drawing out of the shadow root, its <style> included.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "SVG" }).click()]);
  expect(await readFile(await download.path(), "utf8")).toContain(".shape { fill: rgb(1, 2, 3); }");

  // Fullscreen of a drawing is 크게 보기 (lib/zoomViewer.ts): fitted to the window —
  // whole — with its own <style> still on it. (It used to open at its natural size on
  // a stage whose zoom scaled it about the top centre: zoomed in, the left part of a
  // wide drawing could not be scrolled to.)
  const opener = page.getByRole("button", { name: "전체화면" });
  await opener.click();
  const viewer = page.getByRole("dialog", { name: "캔버스 전체화면" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".zoom-viewer-name")).toHaveText("도형");
  await expect(viewer.locator(".zoom-viewer-svg .shape")).toHaveCSS("fill", "rgb(1, 2, 3)");
  const shown = () =>
    viewer.evaluate((el) => {
      const svg = el.querySelector(".zoom-viewer-svg")!.shadowRoot!.querySelector("svg")!.getBoundingClientRect();
      const stage = el.querySelector(".zoom-viewer-stage")!.getBoundingClientRect();
      return { left: svg.left, right: svg.right, top: svg.top, width: svg.width, stageLeft: stage.left, stageRight: stage.right, stageTop: stage.top };
    });
  const fitted = await shown();
  expect(fitted.left).toBeGreaterThan(fitted.stageLeft);
  expect(fitted.right).toBeLessThan(fitted.stageRight);
  expect(Math.round(fitted.width)).toBe(Math.round(fitted.stageRight - fitted.stageLeft - 64));
  // Zoomed past the window, every part is still in reach: a drag brings the left edge in.
  for (let i = 0; i < 4; i += 1) await viewer.getByRole("button", { name: "확대" }).click();
  const zoomed = await shown();
  expect(zoomed.left).toBeLessThan(zoomed.stageLeft);
  expect(zoomed.right).toBeGreaterThan(zoomed.stageRight);
  await page.mouse.move(640, zoomed.top + 20);
  await page.mouse.down();
  await page.mouse.move(640 + (zoomed.stageLeft + 40 - zoomed.left), zoomed.top + 20, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await shown()).left - zoomed.stageLeft)).toBe(40);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();

  // 4. mermaid's id-scoped sheet still styles its nodes inside the shadow root.
  await page.getByRole("tab", { name: "흐름" }).click();
  await expect(panel.locator(".canvas-svg .node").first()).toBeVisible();
  const nodeFill = await panel
    .locator(".canvas-svg .node")
    .first()
    .evaluate((node) => getComputedStyle(node.querySelector("rect, path, polygon") as Element).fill);
  expect(nodeFill).toBe("rgb(236, 236, 255)"); // mermaid's default-theme node fill (#ECECFF)

  // 5. A `vega` canvas an older build stored (the type is retired with the Vega
  // renderer) shows a notice and its source — it does not vanish, and draws nothing.
  await page.getByRole("tab", { name: "막대" }).click();
  await expect(panel.getByText("더 이상 지원하지 않는 Vega 차트 형식의 캔버스입니다. 원본만 표시합니다.")).toBeVisible();
  await expect(panel.locator(".canvas-content")).toContainText('"mark"');
  await expect(panel.locator(".canvas-svg")).toHaveCount(0);
});

test("every labeled mermaid diagram keeps its labels through the sanitize", async ({ page }) => {
  await mockApp(
    page,
    LABELED_MERMAID.map(([title, content], i) => ({ id: `cv-mmd-${i}`, title, content, contentType: "mermaid" })),
  );
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 목업 대화" }).click();

  for (const [title, , label] of LABELED_MERMAID) {
    await page.getByRole("tab", { name: title, exact: true }).click();
    await expect(page.locator(".canvas-panel .canvas-svg svg text", { hasText: label }).first()).toBeVisible();
  }
});

// Fullscreen of a TEXT canvas zooms by a reflow (CanvasTab): the text grows and
// wraps again inside the stage. A CSS scale about the top centre used to push
// the start of every line out of reach.
test("a markdown canvas in fullscreen zooms its text without losing the left edge", async ({ page }) => {
  const LONG = `# 정리\n\n${"긴 문장이 화면 너비를 넘어 이어집니다. ".repeat(40)}`;
  await mockApp(page, [{ id: "cv-doc", title: "문서", content: LONG, contentType: "markdown" }]);
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 목업 대화" }).click();
  await page.getByRole("button", { name: "전체화면" }).click();
  const stage = page.locator(".canvas-fs .canvas-fs-stage");
  await expect(stage.locator("h1")).toHaveText("정리");
  const measure = () =>
    stage.evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const content = el.querySelector(".canvas-fs-content")!.getBoundingClientRect();
      const heading = el.querySelector("h1")!.getBoundingClientRect();
      const text = el.querySelector("p")!.getBoundingClientRect();
      return {
        left: Math.round(content.left - box.left - Number.parseFloat(style.paddingLeft)),
        slack: Math.round(box.right - Number.parseFloat(style.paddingRight) - content.right),
        overflowX: el.scrollWidth - el.clientWidth,
        headingHeight: heading.height,
        textHeight: text.height,
      };
    });
  const at100 = await measure();
  expect(at100).toMatchObject({ left: 0 });
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "확대" }).click();
  await expect(page.locator(".canvas-fs-zoom")).toContainText("160%");
  const at160 = await measure();
  // Still exactly the stage's width, from its left edge — nothing to scroll sideways to, nothing cut.
  expect(at160.left).toBe(0);
  expect(Math.abs(at160.slack)).toBeLessThanOrEqual(1);
  expect(at160.overflowX).toBeLessThanOrEqual(1);
  // The text is larger, and wrapped again into more lines.
  expect(at160.headingHeight / at100.headingHeight).toBeCloseTo(1.6, 1);
  expect(at160.textHeight).toBeGreaterThan(at100.textHeight * 2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-fs")).toHaveCount(0);
});
