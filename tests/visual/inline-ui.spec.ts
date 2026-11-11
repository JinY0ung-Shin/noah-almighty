import { expect, test, type Page } from "@playwright/test";

import { LOCAL_DEMO_UI_ANSWER, LOCAL_DEMO_UI_FENCED_SOURCE } from "../../src/server/agent/localScenarios.js";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Inline UI: an avatar writes component tags straight into its ANSWER TEXT and
// the chat draws them in place — no canvas, no side panel. What jsdom cannot
// show is checked here in a real browser: Svelte legacy mode leaving a stale
// value on screen (jsdom masks it), the app's CSP (no eval / Function anywhere
// in the render path — the interpreter and Vega's AST evaluator), the chart
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

async function mockApp(page: Page, options: { stored?: boolean; streamText?: string } = {}): Promise<{ reports: { messageId: string; errors: string[] }[] }> {
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
          ...(options.stored === false ? [] : [assistantMessage("m-a1", DASHBOARD)]),
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

  // 2. The simple-form chart went through Vega under the app's CSP: 2 months × 2 series.
  await expect(ui.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(4);
  await expect(ui.locator(".wg-stat .stat-value").first()).toHaveText("30만원");

  // 3. An input recomputes everything that reads it — no stale value left on screen.
  await ui.getByRole("slider", { name: "개월 수" }).fill("4");
  await expect(ui.locator(".wg-stat .stat-value").first()).toHaveText("100만원");
  await expect(ui.locator(".wg-stat .stat-value").nth(1)).toHaveText("4");
  await expect(ui.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(8);

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
  await expect(ui.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(4);
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

// The `local` demo runtime's `demo ui` answer (what `AGENT_RUNTIME=local` streams), through the real client:
// the server's own example of inline UI must draw whole, with nothing reported to the avatar.
test("the demo runtime's inline UI answer draws whole and reports nothing", async ({ page }) => {
  const { reports } = await mockApp(page, { stored: false, streamText: LOCAL_DEMO_UI_ANSWER });
  await openConversation(page);
  const composer = page.locator(".composer textarea").first();
  await composer.fill("demo ui");
  await composer.press("Enter");

  const bubble = page.locator(".message.assistant .bubble").last();
  await expect(bubble.locator(".wg-chart .canvas-svg .mark-rect path").first()).toBeVisible({ timeout: 20_000 });
  await expect(bubble.locator(".wg-chart .canvas-svg .mark-arc path").first()).toBeVisible();
  await expect(bubble.getByRole("slider").first()).toBeVisible();
  await expect(bubble.locator("pre code").filter({ hasText: LOCAL_DEMO_UI_FENCED_SOURCE })).toHaveCount(1);
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
