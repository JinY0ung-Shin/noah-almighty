import { expect, test, type Page } from "@playwright/test";

import { LOCAL_DEMO_UI_ANSWER, LOCAL_DEMO_UI_FENCED_SOURCE } from "../../src/server/agent/localScenarios.js";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Inline UI: an avatar writes component tags straight into its ANSWER TEXT and
// the chat draws them in place — no canvas, no side panel. What jsdom cannot
// show is checked here in a real browser: a value on screen that does not
// follow the state (a stale render), the app's CSP (no eval / Function anywhere
// in the render path — the interpreter), the chart
// following the state, the values kept in this browser coming back after a
// reload, and a STREAMING answer never showing its tags as raw text.

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

// The app's own policy (src/server/app.ts) — the Vite dev server sends none, so
// the spec adds it to the document. `ws:` is Vite's HMR socket, nothing else.
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

const CONVERSATION_ID = "c-ui";
const RUN_ID = "run-ui-1";

const DASHBOARD = `분기 매출을 정리했어요.

{@state n = 2}
{@state view = "chart"}
{@const rows = Array.from({ length: n }, (_, i) => ({ month: (i + 1) + "월", sales: (i + 1) * 10, cost: (i + 1) * 6 }))}

<box border padding={3} gap={2}>
  <title size="md">월별 매출</title>
  <slider label="개월 수" value={n} onChange={setN} min={1} max={6} />
  <grid columns={2}>
    <grid-item><stat label="합계" value={\`\${rows.reduce((a, r) => a + r.sales, 0)}만원\`} /></grid-item>
    <grid-item><stat label="개월" value={n} /></grid-item>
  </grid>
  <tabs label="보기" value={view} onChange={setView} options={[{ label: "차트", value: "chart" }, { label: "표", value: "table" }]} />
  {#if view === "chart"}
    <chart type="bar" data={rows} xKey="month" series={[{ key: "sales", label: "매출" }, { key: "cost", label: "비용" }]} unit="만원" label="월별 매출 차트" height={180} />
  {:else}
    <table columns={[{ key: "month", label: "월" }, { key: "sales", label: "매출", align: "end" }]} rows={rows} />
  {/if}
  <button send={\`\${n}개월 매출을 요약해 줘\`}>요약 요청</button>
</box>

원하는 기간으로 바꿔 보세요.

\`\`\`
<chart type="bar" data={rows} />
\`\`\`
`;

function sseFrames(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((frame, index) => `id: ${index + 1}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    conversationId: CONVERSATION_ID,
    role: "assistant",
    content: text,
    createdAt: "2026-11-11T03:00:01.000Z",
    response: { kind: "text", runtime: "pi", summary: "완료", text },
  };
}

async function mockApp(page: Page, options: { stored?: boolean; storedText?: string; streamText?: string } = {}): Promise<{ reports: { messageId: string; errors: string[] }[] }> {
  const streamText = options.streamText ?? DASHBOARD;
  const reports: { messageId: string; errors: string[] }[] = [];
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
    // Raw UI source must never be on screen, not even for a frame of a streaming answer.
    const leaks: string[] = [];
    (window as unknown as { __leaks: string[] }).__leaks = leaks;
    const scan = () => {
      for (const bubble of document.querySelectorAll<HTMLElement>(".message.assistant .bubble")) {
        const clone = bubble.cloneNode(true) as HTMLElement;
        for (const code of clone.querySelectorAll("pre, code")) code.remove();
        const text = clone.textContent ?? "";
        const hit = /<(box|slider|grid|stat|tabs|chart|table|button|title)\b|\{@(state|const)|\{#(if|each)|\{\/(if|each)\}|\{:else/.exec(text);
        if (hit && leaks.length < 5) leaks.push(text.slice(Math.max(0, hit.index - 20), hit.index + 40));
      }
    };
    // `document`, not its root element: an init script runs before there is one.
    new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true });

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
    // Every Web Animation started on a part of a mermaid diagram (lib/mermaidEntrance.ts).
    const diagramMoves: string[] = [];
    (window as unknown as { __diagramMoves: string[] }).__diagramMoves = diagramMoves;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const root = this.getRootNode();
      if (root instanceof ShadowRoot && root.host.classList.contains("code-diagram")) diagramMoves.push(this.tagName.toLowerCase());
      return animate.call(this, keyframes, options);
    };
  });
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
    if (path === "/api/chat/stream" && request.method() === "POST") {
      // The answer arrives in small deltas, mid-tag and mid-expression.
      const deltas: Array<{ event: string; data: unknown }> = [];
      for (let i = 0; i < streamText.length; i += 7) deltas.push({ event: "delta", data: { text: streamText.slice(i, i + 7) } });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sseFrames([
          { event: "open", data: { conversationId: CONVERSATION_ID, runId: RUN_ID, userMessageId: "m-u9" } },
          ...deltas,
          { event: "done", data: { message: assistantMessage("m-a9", streamText) } },
        ]),
      });
      return;
    }
    if (path === `/api/conversations/${CONVERSATION_ID}/ui-report` && request.method() === "POST") {
      reports.push(request.postDataJSON());
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "approval", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/avatars/user-1") {
      body = {
        avatar: { ...user, hasImage: false, pluginCount: 0, visibility: "group", updatedAt: "2026-07-12T03:00:00.000Z", persona: "", isOwn: true, elevated: true, plugins: [] },
      };
    } else if (path === "/api/conversations") {
      body = {
        conversations: [
          { id: CONVERSATION_ID, avatarUserId: "user-1", title: "매출 대화", avatarDisplayName: "진영", updatedAt: "2026-11-11T03:00:00.000Z", isRoutine: false, routineId: null, routinePrompt: null },
        ],
      };
    } else if (path === "/api/messages") {
      body = {
        messages: [
          { id: "m-1", conversationId: CONVERSATION_ID, role: "user", content: "매출 보여줘", response: null, createdAt: "2026-11-11T03:00:00.000Z" },
          ...(options.stored === false ? [] : [assistantMessage("m-a1", options.storedText ?? DASHBOARD)]),
        ],
        canvases: [],
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
  return { reports };
}

const UI = ".message.assistant .bubble > .answer-ui";

async function openConversation(page: Page): Promise<void> {
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 매출 대화" }).click();
}

const diagramMoves = (page: Page) => page.evaluate(() => (window as unknown as { __diagramMoves: string[] }).__diagramMoves);
interface ChartRun {
  id: string;
  shapes: number;
  bar: number;
}
/** Every chart that was mounted, in order (see the sampler in mockApp). */
const chartRuns = (page: Page) => page.evaluate(() => (window as unknown as { __chartRuns: () => ChartRun[] }).__chartRuns());
/** A chart that went through a run of shapes ENTERED; one drawn at rest shows one shape, two after a redraw. */
const entered = (run: ChartRun): boolean => run.shapes >= 6;
/** The rendered height of the first bar of the first chart. */
const firstBarHeight = (page: Page) =>
  page.evaluate(() => document.querySelector(".message.assistant .wg-chart .recharts-bar-rectangle path")?.getBoundingClientRect().height ?? -1);
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const leaks = (page: Page) => page.evaluate(() => (window as unknown as { __leaks: string[] }).__leaks);

test("a stored answer draws its UI in the bubble, recomputes locally and keeps the values in this browser", async ({ page }) => {
  await mockApp(page);
  await openConversation(page);
  const ui = page.locator(UI).first();
  await expect(ui).toBeVisible();

  // 1. The answer's order: Markdown, the UI, Markdown, and the fenced source stays source.
  const bubble = page.locator(".message.assistant .bubble").first();
  await expect(bubble.locator("> .md").first()).toContainText("분기 매출을 정리했어요.");
  await expect(bubble.locator("> .md").last()).toContainText("원하는 기간으로 바꿔 보세요.");
  await expect(bubble.locator("pre code")).toContainText('<chart type="bar" data={rows} />');
  // Nothing opened beside the chat.
  await expect(page.locator(".canvas-panel")).toHaveCount(0);

  // 2. The chart was drawn under the app's CSP: 2 months × 2 series.
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(4);
  await expect(ui.locator(".wg-stat .stat-value").first()).toHaveText("30만원");

  // 3. An input recomputes everything that reads it — no stale value left on screen.
  await ui.getByRole("slider", { name: "개월 수" }).fill("4");
  await expect(ui.locator(".wg-stat .stat-value").first()).toHaveText("100만원");
  await expect(ui.locator(".wg-stat .stat-value").nth(1)).toHaveText("4");
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(8);

  // 4. A tab swaps the chart for the table, and back.
  await ui.getByRole("tab", { name: "표" }).click();
  await expect(ui.locator("table tbody tr")).toHaveCount(4);
  await expect(ui.locator(".wg-chart")).toHaveCount(0);

  // 5. The UI sits in the bubble's width (it does not overflow it).
  const box = await ui.boundingBox();
  const frame = await bubble.boundingBox();
  expect(box && frame && box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1).toBe(true);

  // 6. A reload brings the values back from this browser's storage.
  await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith("noah:inline-ui:user-1:c-ui:m-a1")));
  await page.reload();
  await page.getByRole("button", { name: "대화 열기: 매출 대화" }).click();
  const again = page.locator(UI).first();
  await expect(again.locator(".wg-stat .stat-value").first()).toHaveText("100만원");
  await expect(again.locator("table tbody tr")).toHaveCount(4);

  // 7. A send button posts the viewer's next chat message — the text the control declared.
  const [request] = await Promise.all([
    page.waitForRequest((req) => new URL(req.url()).pathname === "/api/chat/stream" && req.method() === "POST"),
    again.getByRole("button", { name: "요약 요청" }).click(),
  ]);
  expect(request.postDataJSON().message).toBe("4개월 매출을 요약해 줘");
  expect(request.postDataJSON().canvasSubmission).toBeUndefined();

  // 8. None of it needed eval / Function, an inline script or a remote load…
  expect(await cspViolations(page)).toEqual([]);
  // …and the policy really was in force (negative control).
  const control = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        window.addEventListener(
          "message",
          () => {
            try {
              resolve(String(new Function("return 1")()));
            } catch (err) {
              resolve(`blocked:${(err as Error).name}`);
            }
          },
          { once: true },
        );
        window.postMessage("csp-probe", "*");
      }),
  );
  expect(control).toBe("blocked:EvalError");
  expect(await leaks(page)).toEqual([]);
});

test("a streaming answer builds its UI as the text arrives and never shows a tag as text", async ({ page }) => {
  await mockApp(page, { stored: false });
  await openConversation(page);
  const composer = page.locator(".composer textarea").first();
  await composer.fill("매출 대시보드 보여줘");
  await composer.press("Enter");

  // The stored message replaces the live bubble with the same UI, whole.
  const ui = page.locator(UI).first();
  await expect(ui.getByRole("button", { name: "요약 요청" })).toBeVisible({ timeout: 15_000 });
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(4);
  await expect(page.locator(".message.assistant .bubble > .md").last()).toContainText("원하는 기간으로 바꿔 보세요.");
  await expect(page.locator(".message.assistant .bubble > .widget-slot-pending")).toHaveCount(0);
  await expect(page.locator(".canvas-panel")).toHaveCount(0);
  // At no point — live bubble, paced reveal, handover to the stored message — was the source on screen.
  expect(await leaks(page)).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  // The finished answer still works.
  await ui.getByRole("slider", { name: "개월 수" }).fill("3");
  await expect(ui.locator(".wg-stat .stat-value").first()).toHaveText("60만원");
  // Negative control: the watcher does notice source text when it IS on screen.
  await page.evaluate(() => document.querySelector(".message.assistant .bubble > .md")?.append("<box> 원문"));
  await expect.poll(() => leaks(page)).not.toEqual([]);
});

// A chart ENTERS — its bars grow from their baseline — when it appears now: in
// an answer that is being written, or because the viewer pressed something. An
// answer opened from the history, and a redraw of a chart that is already
// there, are drawn at rest; and the answer's two mounts (the live bubble, then
// the stored message) play ONE entrance between them.
test("a chart of an answer opened from the history is drawn at rest; one the viewer brings up enters", async ({ page }) => {
  await mockApp(page);
  await openConversation(page);
  const ui = page.locator(UI).first();
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(4);
  await expect.poll(() => firstBarHeight(page)).toBeGreaterThan(5);
  await page.waitForTimeout(500);
  expect((await chartRuns(page)).map(entered)).toEqual([false]);

  // A redraw (the slider) replaces the drawing at rest.
  await ui.getByRole("slider", { name: "개월 수" }).fill("3");
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(6);
  await page.waitForTimeout(500);
  expect((await chartRuns(page)).map(entered)).toEqual([false]);

  // Leaving for the table and coming back mounts the chart anew, because of the viewer: it enters.
  await ui.getByRole("tab", { name: "표" }).click();
  await expect(ui.locator(".wg-chart")).toHaveCount(0);
  await ui.getByRole("tab", { name: "차트" }).click();
  await expect.poll(async () => (await chartRuns(page)).map(entered)).toEqual([false, true]);
  await expect.poll(() => firstBarHeight(page)).toBeGreaterThan(5);
});

test("a chart of a streaming answer enters once across the live bubble and the stored message", async ({ page }) => {
  await mockApp(page, { stored: false });
  await openConversation(page);
  const composer = page.locator(".composer textarea").first();
  await composer.fill("매출 대시보드 보여줘");
  await composer.press("Enter");

  const ui = page.locator(UI).first();
  await expect(ui.getByRole("button", { name: "요약 요청" })).toBeVisible({ timeout: 15_000 });
  await expect(ui.locator(".wg-chart .recharts-bar-rectangle")).toHaveCount(4);
  // The whole answer is there and stored; the entrance has run its course and the bars stand.
  await expect.poll(() => firstBarHeight(page)).toBeGreaterThan(5);
  await page.waitForTimeout(1200);
  // Two mounts (the live bubble's chart, then the stored message's) and ONE entrance between them:
  // the stored message's chart never plays it a second time.
  const runs = await chartRuns(page);
  expect(runs.length).toBeGreaterThanOrEqual(1);
  expect(runs.filter(entered).length).toBeLessThanOrEqual(1);
  expect(entered(runs[runs.length - 1]) && runs.length > 1).toBe(false);
});

// The `local` demo runtime's `demo ui` answer (what `AGENT_RUNTIME=local` streams), through the real client:
// the server's own example of inline UI must draw whole, with nothing reported to the avatar.
test("the demo runtime's inline UI answer draws whole and reports nothing", async ({ page }) => {
  const { reports } = await mockApp(page, { stored: false, streamText: LOCAL_DEMO_UI_ANSWER });
  await openConversation(page);
  const composer = page.locator(".composer textarea").first();
  await composer.fill("demo ui");
  await composer.press("Enter");

  const bubble = page.locator(".message.assistant .bubble").last();
  await expect(bubble.locator(".wg-chart .recharts-bar-rectangle").first()).toBeVisible({ timeout: 20_000 });
  await expect(bubble.locator(".wg-chart .recharts-pie-sector").first()).toBeVisible();
  await expect(bubble.getByRole("slider").first()).toBeVisible();
  await expect(bubble.locator("pre code").filter({ hasText: LOCAL_DEMO_UI_FENCED_SOURCE })).toHaveCount(1);
  // The ```mermaid block of the demo is a diagram; the fenced tag above stays a plain code block.
  await expect(bubble.locator(".code-block[data-diagram]")).toHaveCount(1);
  await expect(bubble.locator('.code-block[data-diagram="drawn"] .code-diagram')).toBeVisible();
  // Markdown between the blocks is still Markdown.
  await expect(bubble.locator("> .md h2").first()).toBeVisible();
  // Nothing the browser could not draw: no error node, and no report queued for the avatar.
  await expect(bubble.locator(".wg-error")).toHaveCount(0);
  await expect(bubble.locator(".canvas-render-error")).toHaveCount(0);
  await page.waitForTimeout(1800);
  expect(reports).toEqual([]);
  expect(await leaks(page)).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

// A diagram is not a tag: the avatar writes a ```mermaid code block and the block
// draws itself in place (lib/mermaidBlock.ts). In a real browser: mermaid under
// the app's CSP, the drawing inside a shadow root, the source one press away,
// nothing of mermaid's left under <body> — for a plain answer (no inline UI),
// for one that streams, and for a Markdown run of an answer that holds UI.
const FLOW = `flowchart LR
  A["로그인 (SSO)"] --> B{"승인됨?"}
  B -->|"예"| C["홈"]
  B -->|"아니오"| D["대기"]`;
const DIAGRAM_ANSWER = `로그인 흐름은 이렇습니다.\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n승인 전에는 대기 화면에 머뭅니다.`;
const BROKEN_ANSWER = "그림입니다.\n\n```mermaid\nflowchart LR\n  A[로그인 (SSO)] --> B\n```\n\n끝.";

/** The text mermaid drew, read through the block's shadow root. */
const diagramText = (page: Page, nth = 0) =>
  page.evaluate((index) => {
    const host = document.querySelectorAll(".message.assistant .bubble .code-diagram")[index];
    return host?.shadowRoot?.querySelector("svg")?.textContent ?? "";
  }, nth);
const mermaidLeftovers = (page: Page) => page.evaluate(() => document.querySelectorAll('body > [id^="dnoah-mmd"], body > svg').length);

test("a stored answer's mermaid block is drawn in place, with its source one press away", async ({ page }) => {
  const { reports } = await mockApp(page, { storedText: DIAGRAM_ANSWER });
  await openConversation(page);
  const block = page.locator(".message.assistant .bubble .code-block").first();
  await expect(block).toHaveAttribute("data-diagram", "drawn", { timeout: 20_000 });

  // The diagram shows, the <pre> does not; the prose around it is ordinary Markdown.
  await expect(block.locator(".code-diagram")).toBeVisible();
  await expect(block.locator("pre")).toBeHidden();
  await expect.poll(() => diagramText(page)).toContain("로그인 (SSO)");
  expect(await diagramText(page)).toContain("승인됨?");
  await expect(block.locator(".code-lang")).toHaveText("Mermaid");
  await expect(page.locator(".message.assistant .bubble > .md > p").first()).toHaveText("로그인 흐름은 이렇습니다.");
  // The drawing does not overflow the bubble.
  const fits = await block.evaluate((el) => {
    const svg = el.querySelector(".code-diagram")!.shadowRoot!.querySelector("svg")!;
    return svg.getBoundingClientRect().width <= el.getBoundingClientRect().width + 1 && svg.getBoundingClientRect().height > 40;
  });
  expect(fits).toBe(true);
  // An answer opened from the history: the diagram is simply there, nothing arrives.
  expect(await diagramMoves(page)).toEqual([]);

  // 소스: the source instead of the diagram, and back. 줄바꿈 belongs to the source view.
  const toggle = block.getByRole("button", { name: "소스" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(block.getByRole("button", { name: "줄바꿈" })).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(block.locator("pre code")).toBeVisible();
  await expect(block.locator("pre code")).toContainText('A["로그인 (SSO)"] --> B{"승인됨?"}');
  await expect(block.locator(".code-diagram")).toBeHidden();
  await expect(block.getByRole("button", { name: "줄바꿈" })).toBeVisible();
  await toggle.click();
  await expect(block.locator(".code-diagram")).toBeVisible();
  await expect(block.locator("pre")).toBeHidden();

  // The theme flips: the diagram is drawn again in the other palette.
  const before = await block.evaluate((el) => el.querySelector(".code-diagram")!.shadowRoot!.innerHTML);
  await page.evaluate(() => {
    localStorage.setItem("noah-theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "noah-theme", newValue: "dark" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "대화 열기: 매출 대화" }).click();
  const dark = page.locator(".message.assistant .bubble .code-block").first();
  await expect(dark).toHaveAttribute("data-diagram", "drawn", { timeout: 20_000 });
  const after = await dark.evaluate((el) => el.querySelector(".code-diagram")!.shadowRoot!.innerHTML);
  expect(after).not.toBe(before);

  await page.waitForTimeout(1800);
  expect(reports).toEqual([]);
  expect(await mermaidLeftovers(page)).toBe(0);
  expect(await cspViolations(page)).toEqual([]);
});

test("a streaming answer keeps its mermaid block as code until the fence closes, then draws it", async ({ page }) => {
  const { reports } = await mockApp(page, { stored: false, streamText: DIAGRAM_ANSWER });
  await page.addInitScript(() => {
    // A diagram must never be drawn from half a source: every state the block goes through is recorded.
    const states: string[] = [];
    (window as unknown as { __diagramStates: string[] }).__diagramStates = states;
    new MutationObserver(() => {
      for (const block of document.querySelectorAll<HTMLElement>(".code-block[data-diagram]")) {
        const code = block.querySelector("pre > code")?.textContent ?? "";
        const entry = `${block.dataset.diagram}:${code.includes('D["대기"]') ? "whole" : "partial"}`;
        if (states[states.length - 1] !== entry) states.push(entry);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-diagram"] });
  });
  await openConversation(page);
  const composer = page.locator(".composer textarea").first();
  await composer.fill("로그인 흐름 그려 줘");
  await composer.press("Enter");

  const block = page.locator(".message.assistant .bubble .code-block").last();
  await expect(block).toHaveAttribute("data-diagram", "drawn", { timeout: 20_000 });
  await expect.poll(() => diagramText(page)).toContain("대기");
  await expect(page.locator(".message.assistant .bubble").last()).toContainText("승인 전에는 대기 화면에 머뭅니다.");
  const states = await page.evaluate(() => (window as unknown as { __diagramStates: string[] }).__diagramStates);
  // Drawn only from the whole source — never "drawing"/"drawn" while it was partial.
  expect(states.filter((state) => state.endsWith(":partial") && !state.startsWith("code:"))).toEqual([]);
  expect(states).toContain("drawn:whole");
  // It was written just now: its parts arrived in order (the nodes, the edges, their labels) —
  // once, or twice when the stored message took over mid-entrance and continued it.
  const arrived = await diagramMoves(page);
  expect(arrived.filter((tag) => tag === "g").length).toBeGreaterThanOrEqual(4);
  expect(arrived.filter((tag) => tag === "path").length).toBeGreaterThanOrEqual(3);

  await page.waitForTimeout(1800);
  // …and no part was left held or clipped.
  const rest = await page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll(".message.assistant .bubble .code-diagram"));
    const root = hosts[hosts.length - 1]?.shadowRoot;
    return {
      running: root?.getAnimations().length ?? -1,
      nodes: Array.from(root?.querySelectorAll("g.node") ?? []).map((node) => getComputedStyle(node).opacity),
    };
  });
  expect(rest.running).toBe(0);
  expect(rest.nodes.length).toBeGreaterThanOrEqual(4);
  expect(rest.nodes.every((opacity) => opacity === "1")).toBe(true);
  expect(reports).toEqual([]);
  expect(await mermaidLeftovers(page)).toBe(0);
  expect(await cspViolations(page)).toEqual([]);
});

test("a mermaid block that does not parse keeps its source, says why, and is reported to the avatar", async ({ page }) => {
  const { reports } = await mockApp(page, { storedText: BROKEN_ANSWER });
  await openConversation(page);
  const block = page.locator(".message.assistant .bubble .code-block").first();
  await expect(block).toHaveAttribute("data-diagram", "failed", { timeout: 20_000 });
  await expect(block.locator("pre code")).toBeVisible();
  await expect(block.locator("pre code")).toContainText("A[로그인 (SSO)] --> B");
  await expect(block.locator(".code-diagram-note")).toContainText("다이어그램을 그리지 못해 소스를 표시합니다 (상세: Parse error on line 2)");
  await expect(block.getByRole("button", { name: "소스" })).toBeHidden();
  await expect(block.locator(".code-diagram")).toBeHidden();

  await expect.poll(() => reports.length, { timeout: 5000 }).toBe(1);
  expect(reports[0]!.messageId).toBe("m-a1");
  expect(reports[0]!.errors).toHaveLength(1);
  expect(reports[0]!.errors[0]).toMatch(/^```mermaid block: the diagram could not be drawn and the user sees its source instead — Parse error on line 2: /);
  // Mermaid's "Syntax error in text" picture is not left at the bottom of the app.
  expect(await mermaidLeftovers(page)).toBe(0);
  expect(await cspViolations(page)).toEqual([]);
});

test("a mermaid block next to inline UI is drawn too, in the answer's Markdown run", async ({ page }) => {
  const { reports } = await mockApp(page, { storedText: `${DASHBOARD}\n\n구조는 이렇습니다.\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n` });
  await openConversation(page);
  await expect(page.locator(UI).first()).toBeVisible();
  const block = page.locator('.message.assistant .bubble .code-block[data-diagram]');
  await expect(block).toHaveCount(1);
  await expect(block).toHaveAttribute("data-diagram", "drawn", { timeout: 20_000 });
  await expect.poll(() => diagramText(page)).toContain("로그인 (SSO)");
  // The fenced UI source above it is still a plain code block.
  await expect(page.locator(".message.assistant .bubble pre code").filter({ hasText: '<chart type="bar" data={rows} />' })).toBeVisible();
  await page.waitForTimeout(1800);
  expect(reports).toEqual([]);
  expect(await leaks(page)).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
