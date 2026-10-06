import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Canvas content never styles the app. An `html` canvas is a PAGE in its own
// sandboxed frame: its LEADING <style> (the one a body-only sanitize used to drop)
// must style it, and the frame must fit the page. An svg/mermaid/vega canvas is a
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
        groupKnowledgeOff: [],
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

  // 2. The panel still fits the drawing to its width; fullscreen keeps its natural size.
  const width = (selector: string) =>
    page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const hostWidth = await panel.locator(".canvas-svg").evaluate((el) => el.clientWidth);
  expect(await width(".canvas-panel .canvas-svg svg")).toBe(hostWidth);

  // 3. Export reads the drawing out of the shadow root, its <style> included.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "SVG" }).click()]);
  expect(await readFile(await download.path(), "utf8")).toContain(".shape { fill: rgb(1, 2, 3); }");

  await page.getByRole("button", { name: "전체화면" }).click();
  expect(await width(".canvas-fs .canvas-svg svg")).toBe(2000);
  await page.keyboard.press("Escape");

  // 4. mermaid's id-scoped sheet still styles its nodes inside the shadow root.
  await page.getByRole("tab", { name: "흐름" }).click();
  await expect(panel.locator(".canvas-svg .node").first()).toBeVisible();
  const nodeFill = await panel
    .locator(".canvas-svg .node")
    .first()
    .evaluate((node) => getComputedStyle(node.querySelector("rect, path, polygon") as Element).fill);
  expect(nodeFill).toBe("rgb(236, 236, 255)"); // mermaid's default-theme node fill (#ECECFF)

  // 5. vega still draws its marks there.
  await page.getByRole("tab", { name: "막대" }).click();
  await expect(panel.locator(".canvas-svg .mark-rect path")).toHaveCount(2);
});
