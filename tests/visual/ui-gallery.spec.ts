import { expect, test, type Page } from "@playwright/test";

import { UI_GALLERY } from "../../src/client/src/lib/uiGallery.js";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// 인라인 UI 갤러리 (`#/uiGallery`): every sample is an answer drawn by the chat's
// own renderer in its preview mode. In a real browser, under the app's CSP:
// every sample draws (no error node, every chart and diagram really drawn),
// a control that would send to the avatar only SHOWS what it would send, a
// sample's source is one press away, and a chart enters when it is scrolled to.

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

// The app's own policy (src/server/app.ts) — the Vite dev server sends none.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws:",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

interface ChartRun {
  id: string;
  shapes: number;
  bar: number;
}

async function mockApp(page: Page, options: { reduceMotion?: boolean } = {}): Promise<{ sent: string[] }> {
  const sent: string[] = [];
  await page.addInitScript((reduce) => {
    if (reduce) localStorage.setItem("noah-motion", "reduce");
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });

    // Every chart drawing on the page (one entry per mounted chart, in the order
    // they appeared), and how many distinct shapes its marks went through since
    // they were first there. A chart drawn at rest shows one shape (two after a
    // redraw); one that ENTERED went through a whole run of them. The chart
    // library animates by writing attributes frame by frame, so this is read off
    // the marks themselves — bars, slices, a line's dash, an area's reveal clip.
    const runs = new Map<Element, { id: string; shapes: Set<string>; bar: number }>();
    (window as unknown as { __chartRuns: () => unknown[] }).__chartRuns = () => [...runs.values()].map((run) => ({ id: run.id, shapes: run.shapes.size, bar: run.bar }));
    const shapeOf = (host: Element): string => {
      const marks = host.querySelectorAll(".recharts-bar-rectangle path, .recharts-pie-sector path, .recharts-line-curve, .recharts-area-area");
      if (!marks.length) return "";
      const parts: string[] = [];
      marks.forEach((mark) => {
        const box = mark.getBoundingClientRect();
        parts.push(`${Math.round(box.width)}x${Math.round(box.height)}:${mark.getAttribute("stroke-dasharray") ?? ""}:${(mark.getAttribute("d") ?? "").length}`);
      });
      host.querySelectorAll("clipPath rect").forEach((clip) => parts.push(`clip${clip.getAttribute("width")}x${clip.getAttribute("height")}`));
      return parts.join(";");
    };
    const watchCharts = () => {
      for (const host of document.querySelectorAll(".wg-chart")) {
        const shape = shapeOf(host);
        if (!shape) continue;
        let run = runs.get(host);
        if (!run) runs.set(host, (run = { id: host.closest("[data-sample]")?.getAttribute("data-sample") ?? "", shapes: new Set(), bar: 0 }));
        run.shapes.add(shape);
        run.bar = host.querySelector(".recharts-bar-rectangle path")?.getBoundingClientRect().height ?? 0;
      }
      requestAnimationFrame(watchCharts);
    };
    requestAnimationFrame(watchCharts);
    const animate = Element.prototype.animate;
    // Every Web Animation started on a plain element of the UI: "<sample>/<what>" (a table row, or its first class).
    const moves: string[] = [];
    (window as unknown as { __moves: string[] }).__moves = moves;
    const diagrams: string[] = [];
    (window as unknown as { __diagrams: string[] }).__diagrams = diagrams;
    Element.prototype.animate = function (keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const first = Array.isArray(keyframes) ? keyframes[0] : null;
      // …and on a part of a mermaid diagram: "<what it is>:<the property that moves>".
      const root = this.getRootNode();
      if (root instanceof ShadowRoot && root.host.classList.contains("code-diagram") && first) {
        const kind = this.closest("g.node") ? "node" : this.closest("g.edgePaths") ? "edge" : this.closest("g.edgeLabels") ? "label" : /messageLine/.test(this.getAttribute("class") ?? "") ? "message" : "part";
        diagrams.push(`${kind}:${Object.keys(first)[0]}`);
      }
      if (this instanceof HTMLElement && this.closest(".ui-gallery-stage")) {
        const sample = this.closest(".ui-gallery-card")?.getAttribute("data-sample") ?? "";
        moves.push(`${sample}/${this.tagName === "TR" ? "tr" : this.classList[0] ?? this.tagName.toLowerCase()}`);
      }
      return animate.call(this, keyframes, options);
    };
  }, options.reduceMotion === true);
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": APP_CSP } });
    },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/chat/stream") sent.push(request.postData() ?? "");
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") body = { needsSetup: false, githubHost: "github.com", signupMode: "approval", confluenceConfigured: false };
    else if (path === "/api/me") body = { user };
    else if (path === "/api/avatars") body = { avatars: [{ ...user, sharesGroup: false }] };
    else if (path === "/api/conversations") body = { conversations: [] };
    else if (path.endsWith("/knowledge/requests")) body = { requests: [] };
    else if (path.endsWith("/notifications")) body = { notifications: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { sent };
}

async function openGallery(page: Page): Promise<void> {
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/#/uiGallery`);
  await expect(page.getByRole("heading", { name: "인라인 UI 갤러리" })).toBeVisible();
}

const card = (page: Page, id: string) => page.locator(`.ui-gallery-card[data-sample="${id}"]`);
const diagrams = (page: Page) => page.evaluate(() => (window as unknown as { __diagrams: string[] }).__diagrams);
const moves = (page: Page) => page.evaluate(() => (window as unknown as { __moves: string[] }).__moves);
/** Every chart that was mounted (see the sampler in mockApp); `of` picks a sample's, in the order they mounted. */
const chartRuns = (page: Page, of?: string) =>
  page.evaluate((sample) => (window as unknown as { __chartRuns: () => ChartRun[] }).__chartRuns().filter((run) => !sample || run.id === sample), of);
/** A chart that went through a run of shapes ENTERED; one drawn at rest shows one shape, two after a redraw. */
const entered = (run: ChartRun | undefined): boolean => Boolean(run && run.shapes >= 6);
/** The drawing of a sample's chart (the library's own <svg>). */
const drawing = (page: Page, id: string) => card(page, id).locator('.wg-chart svg[role="application"]');
/** The rendered height of a chart's first bar. */
const firstBarHeight = (page: Page, id: string) =>
  page.evaluate((sample) => document.querySelector(`.ui-gallery-card[data-sample="${sample}"] .wg-chart .recharts-bar-rectangle path`)?.getBoundingClientRect().height ?? -1, id);

test("every sample of the gallery draws, under the app's CSP", async ({ page }) => {
  await mockApp(page);
  await openGallery(page);

  const samples = UI_GALLERY.flatMap((section) => section.samples);
  await expect(page.locator(".ui-gallery-card")).toHaveCount(samples.length);
  for (const section of UI_GALLERY) await expect(page.getByRole("heading", { name: section.title, exact: true })).toBeVisible();

  // Every chart is drawn once it is on screen (the state sample starts on its table).
  const charts = samples.filter((sample) => sample.source.includes("<chart") && sample.id !== "chart-state");
  for (const sample of charts) {
    await card(page, sample.id).scrollIntoViewIfNeeded();
    await expect(drawing(page, sample.id)).toHaveCount(1, { timeout: 20_000 });
  }
  // Every diagram was drawn by mermaid.
  await expect(page.locator('.ui-gallery-card .code-block[data-diagram="drawn"]')).toHaveCount(2, { timeout: 20_000 });
  // Nothing fell back to an error or to a tag shown as text.
  await expect(page.locator(".ui-gallery-stage .wg-error")).toHaveCount(0);
  await expect(page.locator(".ui-gallery-stage .wg-warn")).toHaveCount(0);
  await expect(page.locator(".ui-gallery-stage .canvas-render-error")).toHaveCount(0);
  await expect(page.locator(".ui-gallery-stage .widget-slot-pending")).toHaveCount(0);
  for (const stage of await page.locator(".ui-gallery-stage").all()) expect(await stage.innerText()).not.toMatch(/<(box|row|chart|stat|slider|button)\b|\{@(state|const)|\{#(if|each)/);
  // The image sample is source only.
  await expect(card(page, "image").locator(".ui-gallery-stage")).toHaveCount(0);
  await expect(card(page, "image").locator("pre code")).toContainText("<image src=");

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

test("a sample works like an answer, but what it would send is only shown", async ({ page }) => {
  const { sent } = await mockApp(page);
  await openGallery(page);

  // State recomputes in place.
  const calculator = card(page, "calculator");
  await calculator.getByRole("slider", { name: "수량" }).fill("5");
  await expect(calculator.locator(".stat-value")).toHaveText("60,000원");

  // A send button and a <submit> show the message instead of posting it.
  const send = card(page, "send");
  await send.getByRole("slider", { name: "수량" }).fill("7");
  await send.getByRole("button", { name: "이대로 주문" }).click();
  await expect(send.locator(".ui-gallery-sent pre")).toHaveText("수량 7개로 주문해 줘");
  const submit = card(page, "submit");
  await submit.getByRole("button", { name: "이 조건으로 진행" }).click();
  await expect(submit.locator(".ui-gallery-sent pre")).toHaveText("이 조건으로 진행\n- amount: 3000\n- months: 24");
  expect(sent).toEqual([]);
  // Nothing of a preview is kept in this browser.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("noah:inline-ui")))).toEqual([]);

  // The source is one press away, as the text an avatar writes.
  const bar = card(page, "chart-bar");
  await expect(bar.locator("pre code")).toHaveCount(0);
  await bar.locator("summary").click();
  await expect(bar.locator("pre code")).toContainText('<chart type="bar" data={[{ month: "7월"');

  // A section button brings its section to the top.
  await page.getByRole("navigation", { name: "갤러리 구역" }).getByRole("button", { name: "다이어그램" }).click();
  await expect(page.getByRole("heading", { name: "다이어그램", exact: true })).toBeInViewport();
});

test("a chart enters when it is on screen: bars grow, a line is wiped in, slices arrive", async ({ page }) => {
  await mockApp(page);
  await openGallery(page);

  // The first chart is in view: its bars grew from their baseline and end at full height.
  await expect.poll(async () => entered((await chartRuns(page, "chart-bar"))[0])).toBe(true);
  await expect.poll(() => firstBarHeight(page, "chart-bar")).toBeGreaterThan(20);

  // A chart far below the fold is not drawn yet — its entrance is not spent off screen — and its place is held.
  const donut = card(page, "chart-donut");
  await expect(donut.locator(".wg-chart-plot")).toHaveCount(1);
  expect(await donut.locator(".wg-chart-plot").evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(240);
  await expect(donut.locator(".recharts-pie-sector")).toHaveCount(0);
  expect(await chartRuns(page, "chart-donut")).toEqual([]);
  // Scrolled to: the slices arrive, with motion.
  await donut.scrollIntoViewIfNeeded();
  await expect(donut.locator(".recharts-pie-sector")).toHaveCount(4, { timeout: 20_000 });
  await expect.poll(async () => entered((await chartRuns(page, "chart-donut"))[0])).toBe(true);

  // The other kinds enter the same way when they come on screen.
  for (const id of ["chart-line", "chart-area", "chart-pie", "chart-bar-horizontal"]) {
    await card(page, id).scrollIntoViewIfNeeded();
    await expect(drawing(page, id)).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(async () => entered((await chartRuns(page, id))[0]), { message: `${id} enters` }).toBe(true);
  }

  // A chart that appears because the viewer pressed something enters too; a redraw of it does not.
  const state = card(page, "chart-state");
  await state.scrollIntoViewIfNeeded();
  expect(await chartRuns(page, "chart-state")).toEqual([]);
  await state.getByRole("tab", { name: "차트" }).click();
  await expect.poll(async () => entered((await chartRuns(page, "chart-state"))[0])).toBe(true);
  await expect.poll(() => firstBarHeight(page, "chart-state")).toBeGreaterThan(20);
  await page.waitForTimeout(900); // the arrival has played out
  const settled = (await chartRuns(page, "chart-state"))[0].shapes;
  await state.getByRole("radio", { name: "천원" }).click();
  await expect(drawing(page, "chart-state")).toHaveCount(1);
  await page.waitForTimeout(500);
  // The redraw landed at rest: at most one new shape (the new values), not another run of them.
  expect((await chartRuns(page, "chart-state"))[0].shapes - settled).toBeLessThanOrEqual(1);
});

test("figures, bars, rows and blocks enter when they are on screen", async ({ page }) => {
  await mockApp(page);
  await openGallery(page);

  // A block of UI rises in — each top-level component of a sample.
  await expect.poll(async () => (await moves(page)).includes("chart-bar/wg-chart")).toBe(true);

  // Below the fold a progress bar is held at its START — empty — until it is scrolled to.
  const barWidth = () => card(page, "progress").locator(".wg-progress-bar").first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  await expect(card(page, "progress").locator(".wg-progress-bar")).toHaveCount(3);
  expect(await barWidth()).toBe(0);

  // A <stat> whose value is one number counts up to it, and ends as the plain value.
  const stat = card(page, "stat");
  await stat.scrollIntoViewIfNeeded();
  const value = stat.locator(".stat-value").first();
  await expect(value.locator(".wg-count-now")).toHaveCount(1);
  // The final text holds the card's size while the number runs.
  expect(await value.locator(".wg-count-final").evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
  await expect(value.locator(".wg-count")).toHaveCount(0, { timeout: 5000 });
  await expect(value).toHaveText("605만원");
  await expect(stat.locator(".stat-value").nth(1)).toHaveText("7");

  // A progress bar fills, and the rows of a table arrive one after the other.
  await card(page, "progress").scrollIntoViewIfNeeded();
  await card(page, "table").scrollIntoViewIfNeeded();
  await expect.poll(async () => (await moves(page)).filter((what) => what === "progress/wg-progress-bar").length).toBe(3);
  await expect.poll(async () => (await moves(page)).filter((what) => what === "table/tr").length).toBe(6);
  // …and end where they were drawn: full width, fully opaque.
  await expect
    .poll(() => card(page, "progress").locator(".wg-progress-bar").first().evaluate((el) => Math.round((el.getBoundingClientRect().width / (el.parentElement?.getBoundingClientRect().width ?? 1)) * 100)))
    .toBe(64);
  await expect.poll(() => card(page, "table").locator("tbody tr").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  // A value the viewer changes is simply the new value: no count, and a sort moves no row.
  const calculator = card(page, "calculator");
  await calculator.scrollIntoViewIfNeeded();
  await expect(calculator.locator(".stat-value .wg-count")).toHaveCount(0, { timeout: 5000 });
  await calculator.getByRole("slider", { name: "수량" }).fill("5");
  await expect(calculator.locator(".stat-value")).toHaveText("60,000원");
  await expect(calculator.locator(".stat-value .wg-count")).toHaveCount(0);
  const rows = (await moves(page)).filter((what) => what.endsWith("/tr")).length;
  await card(page, "table").getByRole("button", { name: "매출" }).click();
  await page.waitForTimeout(300);
  expect((await moves(page)).filter((what) => what.endsWith("/tr")).length).toBe(rows);
});

// The plan is read off mermaid's own SVG (lib/mermaidEntrance.ts): this is where
// a mermaid upgrade that renames `g.node`, `g.edgePaths` or `.messageLine0` shows.
test("a mermaid diagram arrives in order: nodes, then edges drawn to their arrowheads; a sequence from the top", async ({ page }) => {
  await mockApp(page);
  await openGallery(page);
  await expect(page.locator('.ui-gallery-card .code-block[data-diagram="drawn"]')).toHaveCount(2, { timeout: 20_000 });

  // Below the fold: held at their start until they are scrolled to.
  const held = (id: string) =>
    page.evaluate((sample) => {
      const host = document.querySelector(`.ui-gallery-card[data-sample="${sample}"] .code-diagram`);
      return (host?.shadowRoot?.getAnimations() ?? []).map((animation) => animation.playState);
    }, id);
  expect(await held("mermaid-flow")).toContain("paused");
  // …at their START: no node is there yet.
  const nodeOpacity = () =>
    page.evaluate(() => {
      const root = document.querySelector('.ui-gallery-card[data-sample="mermaid-flow"] .code-diagram')?.shadowRoot;
      return Array.from(root?.querySelectorAll("g.node") ?? []).map((node) => getComputedStyle(node).opacity);
    });
  expect(await nodeOpacity()).toEqual(["0", "0", "0", "0"]);

  await card(page, "mermaid-flow").scrollIntoViewIfNeeded();
  await card(page, "mermaid-sequence").scrollIntoViewIfNeeded();
  await expect.poll(async () => [...(await held("mermaid-flow")), ...(await held("mermaid-sequence"))].filter((state) => state === "paused")).toEqual([]);

  const played = await diagrams(page);
  // The flowchart: four nodes fade, three edges are wiped towards their arrowheads, their labels follow.
  expect(played.filter((what) => what === "node:opacity")).toHaveLength(4);
  expect(played.filter((what) => what === "edge:clipPath")).toHaveLength(3);
  expect(played.filter((what) => what === "label:opacity").length).toBeGreaterThanOrEqual(3);
  // The sequence diagram: four messages, each drawn the way it is sent.
  expect(played.filter((what) => what === "message:clipPath")).toHaveLength(4);
  expect(played.filter((what) => what === "part:opacity").length).toBeGreaterThanOrEqual(4);

  // At rest again: every node is fully there, and nothing is left clipped.
  const rest = await page.evaluate(() => {
    const host = document.querySelector('.ui-gallery-card[data-sample="mermaid-flow"] .code-diagram');
    const root = host?.shadowRoot;
    return {
      nodes: Array.from(root?.querySelectorAll("g.node") ?? []).map((node) => getComputedStyle(node).opacity),
      clips: Array.from(root?.querySelectorAll("g.edgePaths > path") ?? []).map((edge) => getComputedStyle(edge).clipPath),
    };
  });
  await expect.poll(() => held("mermaid-flow")).toEqual([]);
  expect(rest.nodes.length).toBe(4);

  // The 소스 toggle and back is the same drawing: nothing plays again.
  const count = (await diagrams(page)).length;
  const flow = card(page, "mermaid-flow");
  await flow.locator(".code-view").click();
  await flow.locator(".code-view").click();
  await page.waitForTimeout(300);
  expect((await diagrams(page)).length).toBe(count);
  const after = await page.evaluate(() => {
    const root = document.querySelector('.ui-gallery-card[data-sample="mermaid-flow"] .code-diagram')?.shadowRoot;
    return {
      nodes: Array.from(root?.querySelectorAll("g.node") ?? []).map((node) => getComputedStyle(node).opacity),
      clips: Array.from(root?.querySelectorAll("g.edgePaths > path") ?? []).map((edge) => getComputedStyle(edge).clipPath),
    };
  });
  expect(after.nodes).toEqual(["1", "1", "1", "1"]);
  expect(after.clips).toEqual(["none", "none", "none"]);
});

test("움직임 줄이기 draws every chart at rest", async ({ page }) => {
  await mockApp(page, { reduceMotion: true });
  await openGallery(page);
  await expect(drawing(page, "chart-bar")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => firstBarHeight(page, "chart-bar")).toBeGreaterThan(20);
  // Nothing waits for the screen either: a chart far below the fold is already drawn.
  await expect(card(page, "chart-donut").locator(".recharts-pie-sector")).toHaveCount(4, { timeout: 20_000 });
  await page.waitForTimeout(500);
  expect((await chartRuns(page)).filter(entered)).toEqual([]);
  // …and everything else: no block rises, no number counts.
  await card(page, "stat").scrollIntoViewIfNeeded();
  await expect(card(page, "stat").locator(".stat-value").first()).toHaveText("605만원");
  await page.waitForTimeout(300);
  expect(await moves(page)).toEqual([]);
  await expect(page.locator(".wg-count")).toHaveCount(0);
  await card(page, "mermaid-flow").scrollIntoViewIfNeeded();
  await expect(card(page, "mermaid-flow").locator('.code-block[data-diagram="drawn"]')).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(300);
  expect(await diagrams(page)).toEqual([]);
});
