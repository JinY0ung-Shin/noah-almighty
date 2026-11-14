#!/usr/bin/env node
// pi 939f064 restyled the admin UI and added the Pretendard font. Its commit says it was looked at with MOCK
// data only, never against a real gateway — this is that look, through Noah's /admin proxy on the boot stack:
//   1) the new font files are served through the proxy (admin only), and pi's CSP lets the page use them;
//   2) every page of the panel renders in a real browser against the real gateway: no page error, no CSP
//      violation, no failed request, the font really loaded, no sideways page scroll — light and dark.
import { mkdirSync } from "node:fs";
import { check, client, finish, loadState, NOAH, repoRequire, W } from "./e2e-common.mjs";

const { chromium } = repoRequire("playwright");

const state = loadState();
const admin = client(state.owner.cookie);
const anonymous = client();
const SHOTS = `${W}/evidence/admin-ui`;
mkdirSync(SHOTS, { recursive: true });

// ---- 1) assets through the proxy
const page0 = await admin.get("/admin/");
const html = await page0.text();
const csp = page0.headers.get("content-security-policy") ?? "";
console.log("CSP:", csp);
const fontSrc = /font-src ([^;]+)/.exec(csp)?.[1] ?? /default-src ([^;]+)/.exec(csp)?.[1] ?? "";
check("pi's CSP reaches the browser and allows same-origin fonts", /'self'/.test(fontSrc), `font policy: ${fontSrc || "(none)"}`);

const cssHref = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
const absolute = (ref, base = "/admin/") => new URL(ref, `${NOAH}${base}`).pathname;
let fonts = [];
for (const href of cssHref) {
  const url = absolute(href);
  const css = await (await admin.get(url)).text();
  fonts.push(...[...css.matchAll(/url\(["']?([^)"']+\.woff2)["']?\)/g)].map((m) => absolute(m[1], url)));
}
fonts = [...new Set(fonts)];
const pretendard = fonts.filter((f) => /pretendard/i.test(f));
check("the stylesheet references three Pretendard weights (400/500/700)", pretendard.length === 3, pretendard.join(" "));
let pretendardBytes = 0;
for (const font of fonts) {
  const res = await admin.get(font);
  const bytes = (await res.arrayBuffer()).byteLength;
  if (/pretendard/i.test(font)) pretendardBytes += bytes;
  check(`GET ${font} → 200 font/woff2 (${bytes} bytes)`, res.status === 200 && /font\/woff2/.test(res.headers.get("content-type") ?? "") && bytes > 10_000);
}
console.log(`Pretendard total: ${(pretendardBytes / 1024 / 1024).toFixed(2)} MiB`);
if (pretendard[0]) {
  const res = await anonymous.get(pretendard[0]);
  check("a font file is NOT served without a Noah admin session", res.status !== 200, `status ${res.status}`);
  const member = state.second ? await client(state.second.cookie).get(pretendard[0]) : null;
  if (member) check("…nor to a non-admin member", member.status !== 200, `status ${member.status}`);
}

// ---- 2) the panel in a real browser, against the real gateway
const PAGES = ["llm", "systemone", "prompts", "tools", "mcp", "skills", "agents", "plugins", "status", "timing", "chat", "history", "requests"];
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const [name, ...rest] = state.owner.cookie.split(";")[0].split("=");
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: "ko-KR" });
  await context.addCookies([{ name, value: rest.join("="), url: NOAH }]);
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
  page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on("response", (response) => response.status() >= 400 && problems.push(`http ${response.status()}: ${new URL(response.url()).pathname}`));

  for (const id of PAGES) {
    await page.goto(`${NOAH}/admin/#/${id}`);
    if (id === PAGES[0]) {
      // The hash alone does not reload: start every scheme from a real load. The reload aborts what the first
      // load still had in flight (net::ERR_ABORTED) — that is this script's doing, so settle and clear first.
      await page.locator(".page-head h1").waitFor({ timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.reload();
    }
    problems.length = 0;
    await page.locator(".page-head h1").waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700); // the page's own first requests
    const facts = await page.evaluate(() => ({
      title: document.querySelector(".page-head h1")?.textContent,
      login: Boolean(document.querySelector(".login")),
      active: document.querySelector(".rail a.active")?.textContent,
      bodyFont: getComputedStyle(document.body).fontFamily,
      pretendard: ["400", "500", "700"].map((w) => document.fonts.check(`${w} 14px Pretendard`)),
      loadedFaces: [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      csp: window.__csp,
    }));
    if (scheme === "light" || id === "llm" || id === "status" || id === "plugins") {
      await page.screenshot({ path: `${SHOTS}/${scheme}-${id}.png`, fullPage: true });
    }
    const ok =
      !facts.login && Boolean(facts.title) && facts.csp.length === 0 && problems.length === 0 && facts.overflowX <= 0 && /Pretendard/.test(facts.bodyFont) && facts.loadedFaces.some((f) => /Pretendard/.test(f));
    check(`[${scheme}] #/${id} renders "${facts.title}" (active: ${facts.active})`, ok, ok ? "" : JSON.stringify({ ...facts, problems }));
    if (id === "timing") {
      const text = await page.locator("main, body").first().innerText();
      check(`[${scheme}] #/timing says how the output speed is counted (pi fed9753)`, text.includes("출력 token 합을 호출 시간 합으로 나눈 값"));
      // pi e0681aa: charts instead of tables — looked at here with the REAL gateway's data (pi's commit used mock data).
      const chart = await page.evaluate(() => ({
        trend: document.querySelectorAll(".trend").length,
        lines: document.querySelectorAll(".trend svg path").length,
        countBars: document.querySelectorAll(".trend-count > *").length,
        split: document.querySelectorAll(".split > *").length,
        legend: document.querySelectorAll(".legend > *").length,
        chartTables: document.querySelectorAll("table.chart, .table.chart").length,
        bars: document.querySelectorAll(".bar").length,
        heading: [...document.querySelectorAll("h2, h3")].map((h) => h.textContent).join(" | "),
      }));
      check(`[${scheme}] #/timing draws the turn-time trend (lines + a count bar per bucket) from real data (pi e0681aa)`, chart.trend === 1 && chart.lines === 2 && chart.countBars >= 1 && text.includes("턴 시간 추이"), JSON.stringify(chart));
      check(`[${scheme}] #/timing shows where the time went as one split bar with a legend, and bars in its three tables`, chart.split >= 1 && chart.legend >= 2 && chart.chartTables === 3 && chart.bars >= 3, JSON.stringify(chart));
      await page.screenshot({ path: `${SHOTS}/${scheme}-timing-e0681aa.png`, fullPage: true });
      const cell = page.locator(".trend-hover > i").last(); // the newest bucket: the turns just made
      if (await cell.count()) {
        await cell.hover();
        const legend = await page.locator(".legend").first().innerText().catch(() => "");
        check(`[${scheme}] #/timing: hovering a bucket puts its values in the legend line`, /\d+개/.test(legend) && /중앙값/.test(legend), legend.replace(/\s+/g, " ").slice(0, 140));
      }
    }
    if (id === PAGES[0]) console.log(`  body font: ${facts.bodyFont}\n  loaded faces: ${facts.loadedFaces.join(", ")}`);
  }

  // A narrow window: the tables scroll inside their own section, never the page.
  if (scheme === "light") {
    await page.setViewportSize({ width: 400, height: 800 });
    for (const id of ["llm", "mcp", "plugins", "status"]) {
      await page.goto(`${NOAH}/admin/#/${id}`);
      await page.locator(".page-head h1").waitFor();
      await page.waitForTimeout(500);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: `${SHOTS}/narrow-${id}.png`, fullPage: true });
      check(`[400px] #/${id} has no sideways page scroll`, overflowX <= 0, `overflow ${overflowX}px`);
    }
  }
  await context.close();
}
await browser.close();
console.log(`screenshots: ${SHOTS}`);
finish();
