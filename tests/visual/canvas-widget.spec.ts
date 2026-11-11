import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// A `widget` canvas is drawn IN the chat bubble of the answer that showed it (its
// `kind: "widget"` attachment places it), not in the side panel — and it
// recomputes in the browser. What jsdom cannot show is checked
// here in a real one: Svelte legacy mode leaving a stale value on screen (jsdom
// masks it), the app's CSP (no eval / Function anywhere in the render path), the
// widget's prose not restyling the app, Hangul staying on the web font, the
// panel and fullscreen copies sharing one state, the chart following the state,
// and the values kept in this browser coming back after a reload.

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

// The prose's <style> and inline style would restyle / cover the app if they got
// through. (Mid-line, so it is Markdown prose: at the start of a line a `<tag>` is
// a component, and the server's check refuses an unknown one.)
const CALC_WIDGET = `{@state n = 2}
{@state note = ""}
{@const rows = Array.from({ length: n }, (_, i) => ({ k: "항목 " + (i + 1), v: (i + 1) * 10 }))}

수량을 **바꿔** 보세요. <style>body { background: rgb(9, 9, 9) !important; } .canvas-panel { visibility: hidden; }</style> <span style="position:fixed;inset:0;background:rgb(9,9,9)">덮개</span> <div class="canvas-fs" id="fake"><button class="btn btn-primary wg-submit">가짜 보내기</button><a href="https://example.test/x">링크</a></div>

<box border>
  <slider label="수량" value={n} onChange={setN} min={1} max={8} />
  <input label="메모" value={note} onChange={setNote} />
  <row>
    <stat label="합계" value={\`\${n * 2}개\`} />
    {#if n > 5}
      <badge tone="warning">많음</badge>
    {/if}
  </row>
  <text>메모: {note}</text>
  <table columns={[{ key: "k", label: "이름" }, { key: "v", label: "값", align: "end" }]} rows={rows} />
  <chart label="항목 차트" height={160} spec={{ mark: "bar", data: { values: rows }, encoding: { x: { field: "k", type: "nominal", title: "이름" }, y: { field: "v", type: "quantitative", title: "값" } } }} />
</box>

<submit values={{ n, note }}>이 수량으로 진행</submit>
`;

/** `legacy`: a widget from before widgets moved into the chat — no attachment in any message. */
type CanvasFixture = { id: string; title: string; content: string; contentType: string; interaction?: string; legacy?: boolean };

// Where an inline widget lives: the card inside an assistant bubble.
const INLINE = ".message.assistant .bubble .canvas-inline";
const ANSWER_HEAD = "만들었어요.";
const ANSWER_TAIL = "값을 바꿔 보세요.";

/** One answer per inline widget: text, the widget's attachment anchored after the first paragraph, more text. */
function widgetAnswers(canvases: CanvasFixture[]) {
  return canvases
    .filter((canvas) => canvas.contentType === "widget" && !canvas.legacy)
    .map((canvas, index) => {
      const head = `${canvas.title} ${ANSWER_HEAD}`;
      const text = `${head}\n\n${ANSWER_TAIL}`;
      return {
        id: `m-a${index}`,
        conversationId: "c-widget",
        role: "assistant",
        content: text,
        createdAt: "2026-11-10T03:00:01.000Z",
        attachments: [{ id: canvas.id, kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", name: canvas.title, anchor: head.length }],
        response: { kind: "text", runtime: "pi", summary: "완료", text },
      };
    });
}

async function mockApp(page: Page, canvases: CanvasFixture[]): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  // The document itself, with the production CSP on it.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": APP_CSP } });
    },
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "approval", confluenceConfigured: false };
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
            id: "c-widget",
            avatarUserId: "user-1",
            title: "계산기 대화",
            avatarDisplayName: "진영",
            updatedAt: "2026-11-10T03:00:00.000Z",
            isRoutine: false,
            routineId: null,
            routinePrompt: null,
          },
        ],
      };
    } else if (path === "/api/messages") {
      body = {
        messages: [
          { id: "m-1", conversationId: "c-widget", role: "user", content: "계산기 보여줘", response: null, createdAt: "2026-11-10T03:00:00.000Z" },
          ...widgetAnswers(canvases),
        ],
        canvases: canvases.map(({ legacy: _legacy, ...canvas }) => canvas),
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

// Handlers that refuse or alter a change, and a control inside a collapsible section.
const GUARDED_WIDGET = `{@state n = 3}
{@state picked = []}

<details title="고급 설정">
  <slider label="상한 5" value={n} onChange={(v) => setN(Math.min(v, 5))} min={0} max={10} />
</details>
{#each ["가", "나", "다"] as k}
  <checkbox checked={picked.includes(k)} onChange={(c) => c ? (picked.length >= 1 ? null : setPicked([...picked, k])) : setPicked(picked.filter((x) => x !== k))}>{k}</checkbox>
{/each}
<select label="지역" value="kr" onChange={() => null} options={["kr", "jp"]} />
<text>n={n} / 고른 수 {picked.length}</text>
`;

// A map-backed checklist: an entry that was never set reads undefined, which a
// checkbox takes as "unchecked" (not as a missing prop).
const CHECKLIST_WIDGET = `{@state done = {}}
{@const items = ["여권", "환전", "보험"]}

{#each items as k}
  <checkbox checked={done[k]} onChange={(c) => setDone({ ...done, [k]: c })}>{k}</checkbox>
{/each}
<text>{Object.values(done).filter((v) => v).length} / {items.length}</text>
`;

// A million elements: the render pass's output budget stops it.
const HEAVY_WIDGET = `<text>머리말</text>
{#each 1000 as i}
  {#each 1000 as j}
    <divider />
  {/each}
{/each}
<text>꼬리말</text>
`;

// Passes the static check (the calls sit inside function bodies) and misbehaves
// in the browser: a setter called while rendering, and a handler that throws.
const LEAKY_WIDGET = `{@state n = 2}
{@state xs = [1, 2]}

<slider label="수량" value={n} onChange={setN} min={0} max={10} />
<text>합계 {n * 2}</text>
<text>{xs.map((x) => setN(x)).length}개</text>
<button onClick={() => setN(null.x)}>깨진 버튼</button>
`;

// What a widget may do to the conversation: say something as the viewer, open a link.
const ACTION_WIDGET = `{@state topic = "매출"}

<input label="주제" value={topic} onChange={setTopic} />
<row>
  <button send={topic + " 요약해 줘"}>요약 요청</button>
  <button href="https://wiki.example.com/guide">가이드 열기</button>
</row>
<text>자세한 내용은 <link href="https://wiki.example.com/a">위키</link>와 [문서](https://docs.example.com/b)를 보세요.</text>
`;

const WIDGET: CanvasFixture = { id: "cv-calc", title: "계산기", content: CALC_WIDGET, contentType: "widget", interaction: "async" };

async function openWidget(page: Page): Promise<void> {
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await page.getByRole("button", { name: "대화 열기: 계산기 대화" }).click();
  await expect(page.locator(`${INLINE} .wg-root`).first()).toBeVisible();
}

async function waitForKoreanFont(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const visibleText = document.body.innerText;
        const faces = await Promise.all(
          [400, 600, 700].map((weight) => document.fonts.load(`${weight} 14px "Noto Sans KR Variable"`, visibleText)),
        );
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return document.fonts.status === "loaded" && faces.every((loaded) => loaded.length > 0);
      }),
    )
    .toBe(true);
}

// Same probe as apple-ui.spec.ts: ask the renderer which platform font each
// Hangul node used (docs/architecture/client.md, "forced layout during mount").
async function assertNoFallbackHangul(page: Page, scope: string): Promise<void> {
  await page.evaluate((selector) => {
    const hangul = /[ㄱ-ㆎ가-힣]/;
    for (const element of document.querySelectorAll<HTMLElement>(`${selector} *`)) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      if (!hangul.test(own)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0) continue;
      const preserved = /^(pre|pre-wrap|break-spaces)$/.test(getComputedStyle(element).whiteSpace);
      const text = element.textContent ?? "";
      const counted = preserved ? text : text.replace(/\s+/g, " ").trim();
      element.setAttribute("data-hangul-probe", String([...counted].filter((ch) => !hangul.test(ch)).length));
    }
  }, scope);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-hangul-probe]" });
    expect(nodeIds.length, "the widget shows Hangul text to probe").toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const nodeId of nodeIds) {
      const { node } = await client.send("DOM.describeNode", { nodeId, depth: 1 });
      const attributes = node.attributes ?? [];
      const nonHangul = Number(attributes[attributes.indexOf("data-hangul-probe") + 1] ?? 0);
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      const systemGlyphs = fonts.filter((font) => !font.isCustomFont).reduce((sum, font) => sum + font.glyphCount, 0);
      if (systemGlyphs > nonHangul) {
        const text = (node.children ?? []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join("");
        offenders.push(`<${node.localName}> "${text.trim().slice(0, 24)}" → ${fonts.map((font) => `${font.familyName}×${font.glyphCount}`).join(", ")}`);
      }
    }
    expect(offenders, "Hangul rendered with a system fallback font (tofu)").toEqual([]);
  } finally {
    await client.detach();
  }
}

const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const bodyBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const BAR_VEGA = JSON.stringify({
  data: { values: [{ k: "A", v: 3 }, { k: "B", v: 5 }] },
  mark: "bar",
  encoding: { x: { field: "k", type: "nominal" }, y: { field: "v", type: "quantitative" } },
});

test("a widget is drawn in the chat bubble and recomputes there: no stale value, no CSP violation, nothing leaks into the app", async ({ page }) => {
  await mockApp(page, [{ id: "cv-bar", title: "막대", content: BAR_VEGA, contentType: "vega" }, WIDGET]);
  await openWidget(page);

  // 0. The widget sits INSIDE the answer, between the text before and after its
  //    anchor — and every other canvas type is still a side-panel tab.
  const flow = page.locator(".message.assistant .bubble > .md, .message.assistant .bubble > .msg-images");
  await expect(flow).toHaveCount(3);
  await expect(flow.nth(0)).toContainText(ANSWER_HEAD);
  await expect(flow.nth(1).locator(".canvas-inline .wg-root")).toBeVisible();
  await expect(flow.nth(2)).toHaveText(ANSWER_TAIL);
  const order = await page.evaluate((selector) => {
    const widget = document.querySelector(selector)!.getBoundingClientRect();
    const blocks = [...document.querySelectorAll(".message.assistant .bubble > .md")].map((el) => el.getBoundingClientRect());
    return blocks[0].bottom <= widget.top && widget.bottom <= blocks[1].top;
  }, INLINE);
  expect(order).toBe(true);
  const sidePanel = page.locator(".canvas-panel");
  await expect(sidePanel.getByRole("tab")).toHaveText(["막대"]);
  await expect(sidePanel.locator(".canvas-svg .mark-rect path")).toHaveCount(2);
  await expect(sidePanel.locator(".wg-root")).toHaveCount(0);
  await expect(page.locator(".wg-root")).toHaveCount(1);
  const card = page.locator(INLINE);
  const before = await bodyBackground(page);

  // 1. First render: derived text, the table and the chart all come from the state.
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("4개");
  await expect(card.locator(".wg-table tbody tr")).toHaveCount(2);
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(2);
  await expect(card.locator(".wg-chart .canvas-svg")).toHaveAttribute("aria-label", "항목 차트");
  await expect(card.locator(".wg-badge")).toHaveCount(0);

  // 2. The prose's <style> and inline style were dropped: the app looks as it did,
  //    and nothing in the widget sits over it.
  await expect(card).toBeVisible();
  expect(await bodyBackground(page)).toBe(before);
  expect(before).not.toBe("rgb(9, 9, 9)");
  expect(await card.locator(".wg-md style").count()).toBe(0);
  expect(await card.locator(".wg-md [style]").count()).toBe(0);
  await expect(card.locator(".wg-md strong")).toHaveText("바꿔");
  //    Nor can the prose borrow the app's own classes: no fake overlay, no
  //    look-alike submit button, no link — only their text is left.
  expect(await page.locator(".canvas-fs").count()).toBe(0);
  expect(await card.locator(".wg-md [class], .wg-md [id], .wg-md button, .wg-md div").count()).toBe(0);
  //    A link in the prose IS a link — an http(s) one, opened in a new tab.
  await expect(card.locator(".wg-md a")).toHaveAttribute("href", "https://example.test/x");
  await expect(card.locator(".wg-md a")).toHaveAttribute("target", "_blank");
  await expect(card.locator(".wg-md a")).toHaveAttribute("rel", "noopener noreferrer");
  await expect(card.locator(".wg-submit")).toHaveCount(1);
  await expect(card.locator(".wg-md")).toContainText("가짜 보내기");

  // 3. Moving the slider updates every dependent — in a real browser, where a
  //    stale legacy-mode read would show.
  const slider = card.getByRole("slider", { name: "수량" });
  await slider.fill("7");
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("14개");
  await expect(card.locator(".canvas-slider-val")).toHaveText("7");
  await expect(card.locator(".wg-badge")).toHaveText("많음");
  await expect(card.locator(".wg-table tbody tr")).toHaveCount(7);
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(7);
  // Stepping with the keyboard keeps the same control focused across re-renders.
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("10개");
  await expect(slider).toBeFocused();
  await expect(card.locator(".wg-badge")).toHaveCount(0);
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(5);

  // 4. Typing keeps the caret in the field while the text it feeds follows.
  const memo = card.getByRole("textbox", { name: "메모" });
  await memo.pressSequentially("한글 <b>메모</b>");
  await expect(memo).toHaveValue("한글 <b>메모</b>");
  await expect(memo).toBeFocused();
  await expect(card.locator(".wg-box > .wg-text")).toHaveText("메모: 한글 <b>메모</b>");
  expect(await card.locator(".wg-root b").count()).toBe(0);

  // 5. Hangul stays on the web font (no forced layout during the widget's mount).
  await waitForKoreanFont(page);
  await assertNoFallbackHangul(page, `${INLINE} .wg-root`);

  // 6. Fullscreen (the card's own ⤢) shows the SAME widget state, and a change there reaches the bubble.
  await card.getByRole("button", { name: "전체화면" }).click();
  const stage = page.locator(".canvas-fs");
  await expect(stage.locator(".wg-stat .stat-value")).toHaveText("10개");
  await expect(stage.getByRole("textbox", { name: "메모" })).toHaveValue("한글 <b>메모</b>");
  await stage.getByRole("slider", { name: "수량" }).fill("3");
  await expect(stage.locator(".wg-stat .stat-value")).toHaveText("6개");
  await expect(stage.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(stage).toHaveCount(0);
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("6개");
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(3);

  // 7. <submit> sends the widget's values through the canvas submission path.
  const [request] = await Promise.all([
    page.waitForRequest((req) => new URL(req.url()).pathname === "/api/chat/stream" && req.method() === "POST"),
    card.getByRole("button", { name: "이 수량으로 진행" }).click(),
  ]);
  expect(request.postDataJSON().canvasSubmission).toEqual({ canvasId: "cv-calc", values: { n: 3, note: "한글 <b>메모</b>" } });

  // 8. None of it needed eval / Function, an inline script or a remote load…
  expect(await cspViolations(page)).toEqual([]);
  // …and the policy really was in force (negative control). The probe runs in a
  // task the PAGE started: code handed to page.evaluate itself is exempt from CSP.
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
  expect(await cspViolations(page)).toEqual(["script-src eval"]);
});

test("a widget follows the dark theme and comes back with its values after a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApp(page, [WIDGET]);
  await openWidget(page);
  const card = page.locator(INLINE);
  // A conversation whose only canvas is an inline widget has no side panel at all.
  await expect(page.locator(".canvas-panel")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Token colors resolve against the dark palette, in the widget and in its chart.
  const token = (name: string) =>
    page.evaluate((prop) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${prop})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, name);
  await expect(card.locator(".wg-stat .stat-value")).toHaveCSS("color", await token("--text"));
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(2);
  const axisLabel = card.locator(".wg-chart .canvas-svg .role-axis-label text").first();
  await expect(axisLabel).toBeVisible();
  expect(await axisLabel.evaluate((el) => getComputedStyle(el).fill)).toBe(await token("--muted"));

  // What the viewer changed is kept in this browser and restored on the next visit.
  await card.getByRole("slider", { name: "수량" }).fill("6");
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("12개");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("noah:canvas-widget:user-1:c-widget:cv-calc")))
    .toBe(JSON.stringify({ n: { sig: "n = 2", value: 6 } }));
  await page.reload();
  await page.getByRole("button", { name: "대화 열기: 계산기 대화" }).click();
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("12개");
  await expect(card.getByRole("slider", { name: "수량" })).toHaveValue("6");
  await expect(card.locator(".wg-chart .canvas-svg .mark-rect path")).toHaveCount(6);

  // A change made just before leaving is not lost to the save debounce.
  await card.getByRole("slider", { name: "수량" }).fill("8");
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("16개");
  await page.reload();
  await page.getByRole("button", { name: "대화 열기: 계산기 대화" }).click();
  await expect(card.locator(".wg-stat .stat-value")).toHaveText("16개");
  expect(await cspViolations(page)).toEqual([]);
});

test("a control shows the state's value even when its handler refuses the change, and a section stays open", async ({ page }) => {
  await mockApp(page, [{ id: "cv-guard", title: "제한", content: GUARDED_WIDGET, contentType: "widget" }]);
  await openWidget(page);
  const card = page.locator(INLINE);
  const summary = card.locator(".wg-root > .wg-text");
  await expect(summary).toHaveText("n=3 / 고른 수 0");

  // The person opens the section and drags the slider inside it: the section
  // must not snap shut when the state it changes re-renders the widget.
  const section = card.locator("details.wg-details");
  await expect(section).not.toHaveAttribute("open", "");
  await section.locator("summary").click();
  await expect(section).toHaveAttribute("open", "");
  const slider = card.getByRole("slider", { name: "상한 5" });
  await slider.fill("4");
  await expect(summary).toHaveText("n=4 / 고른 수 0");
  await expect(section).toHaveAttribute("open", "");
  await expect(slider).toBeVisible();

  // The handler clamps at 5: the thumb goes back to what the state holds.
  await slider.fill("9");
  await expect(summary).toHaveText("n=5 / 고른 수 0");
  await expect(slider).toHaveValue("5");
  await expect(card.locator(".canvas-slider-val")).toHaveText("5");
  await expect(section).toHaveAttribute("open", "");

  // "At most one": the second box is refused and does not stay ticked.
  await card.getByRole("checkbox", { name: "가" }).click();
  await expect(card.getByRole("checkbox", { name: "가" })).toBeChecked();
  await card.getByRole("checkbox", { name: "나" }).click();
  await expect(card.getByRole("checkbox", { name: "나" })).not.toBeChecked();
  await expect(summary).toHaveText("n=5 / 고른 수 1");

  // A select whose handler ignores the pick keeps showing the state's option.
  const select = card.getByRole("combobox", { name: "지역" });
  await select.selectOption({ label: "jp" });
  await expect(select).toHaveValue("0");

  expect(await cspViolations(page)).toEqual([]);
});

test("a widget that renders too much ends in one notice without freezing the tab, and a map-backed checklist works", async ({ page }) => {
  await mockApp(page, [
    { id: "cv-heavy", title: "과다", content: HEAVY_WIDGET, contentType: "widget" },
    { id: "cv-list", title: "준비물", content: CHECKLIST_WIDGET, contentType: "widget" },
  ]);
  const started = Date.now();
  await openWidget(page);
  // Two widgets, each in the bubble of its own answer.
  const heavy = page.locator(INLINE, { hasText: "과다" });
  const list = page.locator(INLINE, { hasText: "준비물" });
  await expect(page.locator(INLINE)).toHaveCount(2);

  // The heavy widget: what came before the oversized block is shown, the block
  // and everything after it are not, and ONE notice says so — promptly.
  await expect(heavy.locator(".wg-error")).toHaveText("위젯이 그리는 내용이 너무 많아 일부를 표시하지 못했습니다.");
  expect(Date.now() - started).toBeLessThan(8000);
  await expect(heavy.locator(".wg-error")).toHaveCount(1);
  await expect(heavy.locator(".wg-error")).toHaveAttribute("title", /output budget/);
  await expect(heavy.locator(".wg-root > .wg-text")).toHaveText("머리말");
  expect(await heavy.locator(".wg-divider").count()).toBe(0);

  // The page is responsive, and the checklist next to it works: three real,
  // unchecked boxes that count as they are ticked.
  const count = list.locator(".wg-root > .wg-text");
  await expect(list.getByRole("checkbox")).toHaveCount(3);
  await expect(list.locator(".wg-error")).toHaveCount(0);
  await expect(count).toHaveText("0 / 3");
  await list.getByRole("checkbox", { name: "환전" }).click();
  await expect(count).toHaveText("1 / 3");
  await expect(list.getByRole("checkbox", { name: "환전" })).toBeChecked();
  await expect(list.getByRole("checkbox", { name: "여권" })).not.toBeChecked();
  await list.getByRole("checkbox", { name: "여권" }).click();
  await expect(count).toHaveText("2 / 3");
  expect(await cspViolations(page)).toEqual([]);
});

test("what goes wrong in the browser is said in place and reported to the avatar once", async ({ page }) => {
  await mockApp(page, [{ id: "cv-leaky", title: "새는 위젯", content: LEAKY_WIDGET, contentType: "widget" }]);
  const reports: { conversationId: string; errors: string[] }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/canvases/cv-leaky/render-report" && request.method() === "POST") {
      reports.push(request.postDataJSON());
    }
  });
  await openWidget(page);
  const card = page.locator(INLINE);

  // The setter called while rendering did nothing — the state is what it was —
  // and the viewer is told so under that block, with the reason as a tooltip.
  await expect(card.locator(".wg-root > .wg-text").first()).toHaveText("합계 4");
  const warn = card.locator(".wg-warn");
  await expect(warn).toHaveText("렌더 중에 호출된 상태 변경은 무시됩니다.");
  await expect(warn).toHaveAttribute("title", /setN\(…\) was called while rendering and was ignored/);

  // The avatar hears about it a moment later: one report, in English, with the line.
  await expect.poll(() => reports.length, { timeout: 5000 }).toBe(1);
  expect(reports[0]).toEqual({
    conversationId: "c-widget",
    errors: ["line 6:1 setN(…) was called while rendering and was ignored — call a setter only from an event handler (onChange/onClick)."],
  });

  // Using the widget re-evaluates it over and over; the same failure is not sent again.
  await card.getByRole("slider", { name: "수량" }).fill("7");
  await expect(card.locator(".wg-root > .wg-text").first()).toHaveText("합계 14");
  await card.getByRole("button", { name: "전체화면" }).click();
  await expect(page.locator(".canvas-fs .wg-warn")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1800);
  expect(reports).toHaveLength(1);

  // A handler that fails is said in the status line and reported when it happens.
  await card.getByRole("button", { name: "깨진 버튼" }).click();
  await expect(card.locator(".wg-status")).toHaveText("동작을 실행하지 못했습니다.");
  await expect.poll(() => reports.length, { timeout: 5000 }).toBe(2);
  expect(reports[1].errors).toHaveLength(1);
  expect(reports[1].errors[0]).toMatch(/^an event handler failed: /);
  expect(await cspViolations(page)).toEqual([]);
});

test("a send button speaks as the viewer, links open in a new tab, and a widget without an attachment stays in the panel", async ({ page }) => {
  await mockApp(page, [
    { id: "cv-old", title: "예전 위젯", content: CHECKLIST_WIDGET, contentType: "widget", legacy: true },
    { id: "cv-act", title: "요약 도우미", content: ACTION_WIDGET, contentType: "widget" },
  ]);
  await openWidget(page);

  // The widget made before widgets moved into the chat has no attachment: it is
  // still reachable, as a side-panel tab — never drawn twice, never lost.
  const sidePanel = page.locator(".canvas-panel");
  await expect(sidePanel.getByRole("tab")).toHaveText(["예전 위젯"]);
  await expect(sidePanel.locator(".wg-root").getByRole("checkbox")).toHaveCount(3);
  const card = page.locator(INLINE);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".canvas-title")).toHaveText("요약 도우미");

  // Links: a new tab, no opener, and the address as the tooltip.
  const links = card.locator("a");
  await expect(links).toHaveText(["가이드 열기", "위키", "문서"]);
  for (const [index, href] of ["https://wiki.example.com/guide", "https://wiki.example.com/a", "https://docs.example.com/b"].entries()) {
    await expect(links.nth(index)).toHaveAttribute("href", href);
    await expect(links.nth(index)).toHaveAttribute("target", "_blank");
    await expect(links.nth(index)).toHaveAttribute("rel", "noopener noreferrer");
    await expect(links.nth(index)).toHaveAttribute("title", href);
  }

  // The send button shows what it will say before it is pressed, follows the
  // widget's state, and sends that sentence as an ordinary message of the viewer.
  const send = card.getByRole("button", { name: "요약 요청" });
  await expect(send).toHaveAttribute("title", "보낼 메시지: 매출 요약해 줘");
  await card.getByRole("textbox", { name: "주제" }).fill("재고");
  await expect(send).toHaveAttribute("title", "보낼 메시지: 재고 요약해 줘");
  // Something the viewer is typing in the composer must survive the widget's send.
  const composer = page.locator(".composer textarea").first();
  await composer.fill("쓰던 글");
  const [request] = await Promise.all([
    page.waitForRequest((req) => new URL(req.url()).pathname === "/api/chat/stream" && req.method() === "POST"),
    send.click(),
  ]);
  const body = request.postDataJSON();
  expect(body.message).toBe("재고 요약해 줘");
  expect(body.canvasSubmission).toBeUndefined();
  expect(body.conversationId).toBe("c-widget");
  await expect(page.locator(".message.user .bubble").last()).toHaveText("재고 요약해 줘");
  await expect(composer).toHaveValue("쓰던 글");
  expect(await cspViolations(page)).toEqual([]);
});

// A sortable table, icons and a drawing bound to state (the 2026-11-11 additions).
const MORE_WIDGET = `{@state pct = 60}
{@state extra = 0}
{@const a = Math.PI * (1 - pct / 100)}
{@const rows = [{ name: "다람쥐", score: 9 + extra }, { name: "가방", score: 100 }, { name: "나비", score: 10 }, { name: "하늘", score: null }]}

<slider label="진행률" value={pct} onChange={setPct} suffix="%" />
<svg viewBox="0 0 200 110" label="진행률 게이지">
  <defs>
    <linearGradient id="arc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="success" /><stop offset="1" stop-color="danger" /></linearGradient>
    <clipPath id="top"><rect x="0" y="0" width="200" height="101" /></clipPath>
  </defs>
  <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#arc)" stroke-width="14" clip-path="url(#top)" />
  <line x1="100" y1="100" x2={100 + 70 * Math.cos(a)} y2={100 - 70 * Math.sin(a)} stroke={pct > 80 ? "danger" : "accent"} stroke-width="4" stroke-linecap="round" />
  <text x="100" y="90" text-anchor="middle" font-size="20" font-weight="bold">{pct}%</text>
</svg>
<row gap={1}><icon name="clock" color="muted" /><text color="muted">남은 시간</text><icon name="check" size="lg" color="success" label="완료됨" /></row>
<callout tone="warning" icon="clock" title="마감">내일까지입니다.</callout>
<button onClick={() => setExtra(extra + 200)} icon="plus">점수 올리기</button>
<table sortable caption="점수표" columns={[{ key: "name", label: "이름" }, { key: "score", label: "점수", align: "end" }]} rows={rows} />
`;

test("a sortable table keeps focus, icons draw, and an svg follows a slider without re-mounting or leaving the widget", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApp(page, [{ id: "cv-more", title: "게이지", content: MORE_WIDGET, contentType: "widget" }]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWidget(page);
  await waitForKoreanFont(page);
  const widget = page.locator(INLINE);
  const background = await bodyBackground(page);

  // ── sortable table ──
  const names = () => widget.locator("tbody tr td:first-child").allTextContents();
  const scoreHeader = widget.getByRole("columnheader", { name: /^점수/ });
  const score = widget.getByRole("button", { name: "점수", exact: true });
  await expect.poll(names).toEqual(["다람쥐", "가방", "나비", "하늘"]);
  await expect(scoreHeader).toHaveAttribute("aria-sort", "none");
  await score.click();
  await expect.poll(names).toEqual(["다람쥐", "나비", "가방", "하늘"]); // 9, 10, 100, empty last
  await expect(scoreHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(score).toBeFocused();
  // The keyboard works the same button, and focus never leaves it.
  await page.keyboard.press("Enter");
  await expect.poll(names).toEqual(["가방", "나비", "다람쥐", "하늘"]);
  await expect(scoreHeader).toHaveAttribute("aria-sort", "descending");
  await expect(score).toBeFocused();
  // A re-evaluation (new rows from new state) keeps the sort and applies it to the new values.
  await widget.getByRole("button", { name: "점수 올리기" }).click();
  await expect.poll(names).toEqual(["다람쥐", "가방", "나비", "하늘"]); // 209, 100, 10, empty
  await expect(scoreHeader).toHaveAttribute("aria-sort", "descending");
  await score.click();
  await expect.poll(names).toEqual(["다람쥐", "가방", "나비", "하늘"]); // the document's own order
  await expect(scoreHeader).toHaveAttribute("aria-sort", "none");
  await expect(score).toBeFocused();
  await widget.getByRole("button", { name: "이름", exact: true }).click();
  await expect.poll(names).toEqual(["가방", "나비", "다람쥐", "하늘"]);
  // The header is a real, visible target as wide as its cell.
  const headerBox = await score.boundingBox();
  const cellBox = await scoreHeader.boundingBox();
  expect(Math.round(headerBox!.width)).toBe(Math.round(cellBox!.width));
  expect(headerBox!.height).toBeGreaterThan(20);

  // ── icons ──
  const icons = await widget.locator(".wg-icon").evaluateAll((nodes) =>
    nodes.map((node) => {
      const svg = node.querySelector("svg")!;
      const box = svg.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height), shapes: svg.children.length, color: getComputedStyle(svg).color, hidden: node.getAttribute("aria-hidden"), role: node.getAttribute("role"), label: node.getAttribute("aria-label") };
    }),
  );
  const token = (name: string) => page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${v})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
  expect(icons).toEqual([
    { w: 18, h: 18, shapes: 2, color: await token("--muted"), hidden: "true", role: null, label: null },
    { w: 24, h: 24, shapes: 1, color: await token("--ok"), hidden: null, role: "img", label: "완료됨" },
  ]);
  await expect(widget.getByRole("img", { name: "완료됨" })).toBeVisible();
  await expect(widget.locator(".wg-callout-mark svg")).toBeVisible();
  const withIcon = widget.getByRole("button", { name: "점수 올리기" });
  expect(await withIcon.evaluate((button) => [button.firstElementChild?.tagName.toLowerCase(), Math.round(button.firstElementChild!.getBoundingClientRect().width)])).toEqual(["svg", 14]);

  // ── svg bound to the slider ──
  const host = widget.locator(".wg-svg");
  await expect(host).toHaveAttribute("role", "img");
  await expect(host).toHaveAttribute("aria-label", "진행률 게이지");
  const drawing = () =>
    host.evaluate((node) => {
      const root = node.shadowRoot!;
      const line = root.querySelector("line")!;
      const path = root.querySelector("path")!;
      const svg = root.querySelector("svg")!;
      const stroke = getComputedStyle(path).stroke;
      const id = /#([A-Za-z0-9_-]+)/.exec(stroke)?.[1] ?? "";
      return {
        x2: line.getAttribute("x2"),
        needle: getComputedStyle(line).stroke,
        text: root.querySelector("text")!.textContent,
        textFill: getComputedStyle(root.querySelector("text")!).fill,
        gradientFound: Boolean(id && root.getElementById(id)?.tagName === "linearGradient"),
        gradientInPage: Boolean(id && document.getElementById(id)),
        clipped: /^url\(/.test(getComputedStyle(path).clipPath),
        width: Math.round(svg.getBoundingClientRect().width),
        height: Math.round(svg.getBoundingClientRect().height),
        marked: (node as unknown as { __mark?: number }).__mark ?? null,
        sameRoot: (window as unknown as { __root?: ShadowRoot }).__root === root,
        animations: root.getAnimations().length,
        // Nothing of the drawing is in the app's own DOM (the icons' paths are — they are the app's).
        inAppDom: document.querySelectorAll(".wg-svg *, .wg-root linearGradient, .wg-root clipPath, .wg-root text").length,
      };
    });
  const before = await drawing();
  expect(before).toMatchObject({ x2: "121.6312", text: "60%", gradientFound: true, gradientInPage: false, clipped: true, width: 200, height: 110, animations: 0, inAppDom: 0 });
  expect(before.needle).toBe(await token("--accent"));
  expect(before.textFill).toBe(await token("--text"));
  // Mark the host and its shadow root, and watch every frame of the drag for an empty drawing.
  await host.evaluate((node) => {
    (node as unknown as { __mark: number }).__mark = 1;
    const w = window as unknown as { __root: ShadowRoot; __empty: number; __frames: number; __watch: boolean };
    w.__root = node.shadowRoot!;
    w.__empty = 0;
    w.__frames = 0;
    w.__watch = true;
    const tick = () => {
      if (!w.__watch) return;
      w.__frames++;
      if (!node.shadowRoot!.querySelector("svg line")) w.__empty++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const slider = widget.getByRole("slider", { name: "진행률" });
  for (const value of ["65", "70", "75", "80", "85", "90"]) {
    await slider.fill(value);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  const after = await drawing();
  expect(after).toMatchObject({ x2: "166.574", text: "90%", gradientFound: true, marked: 1, sameRoot: true, animations: 0, inAppDom: 0, width: 200 });
  expect(after.needle).toBe(await token("--danger"));
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __empty: number; __frames: number; __watch: boolean };
    w.__watch = false;
    return { empty: w.__empty, frames: w.__frames };
  });
  expect(frames.frames).toBeGreaterThan(5);
  expect(frames.empty).toBe(0);

  // The dark theme reaches the drawing through the tokens (it lives in a shadow root).
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect.poll(async () => (await drawing()).textFill).toBe(await token("--text"));
  expect((await drawing()).textFill).not.toBe(before.textFill);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // Nothing leaked into the app, and nothing needed a CSP exception.
  expect(await bodyBackground(page)).toBe(background);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await cspViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.WIDGET_SHOT_DIR) await widget.screenshot({ path: `${process.env.WIDGET_SHOT_DIR}/more-light.png` });
});
