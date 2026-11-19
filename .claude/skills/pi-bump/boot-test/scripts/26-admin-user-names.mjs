#!/usr/bin/env node
// U — Noah's names on pi's admin panel (Noah `routes/piAdminProxy.ts`, 2026-11-19). pi knows a user only as the
// id Noah sends it (a UUID), so its tables name people by UUID. Noah adds two tags to pi's page DOCUMENT that
// load its own script and stylesheet; the script marks an element that shows a known id with the user's name
// and the stylesheet draws it before the id. Noah's tests run the proxy against a fake pi and the script in
// jsdom — this is the look only a stack gives: pi's REAL page, under pi's REAL CSP, drawn by Preact, in a browser.
// Run after the other checks: the status and history tables need the turns they made.
import { check, client, finish, loadState, NOAH, repoRequire, W } from "./e2e-common.mjs";

const { chromium } = repoRequire("playwright");
const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const ADDITION = '<link rel="stylesheet" href="/pi-admin-names.css"><script src="/pi-admin-names.js" defer></script>';

// ---------------------------------------------------------------------------------------------- what is served
const page = await admin.get("/admin/");
const html = await page.text();
check("U  pi's page document carries Noah's two tags once, right before </head>", html.split(ADDITION).length === 2 && html.includes(`${ADDITION}</head>`), html.slice(0, 400).replace(/\s+/g, " "));
const csp = page.headers.get("content-security-policy") ?? "";
check("U  …under pi's own CSP, which allows a same-origin script and stylesheet", /script-src 'self'/.test(csp) && /style-src [^;]*'self'/.test(csp), csp);
for (const [file, type] of [["/pi-admin-names.js", /javascript/], ["/pi-admin-names.css", /text\/css/]]) {
  const res = await admin.get(file);
  check(`U  GET ${file} → 200 ${res.headers.get("content-type")}`, res.status === 200 && type.test(res.headers.get("content-type") ?? ""));
}
const names = await admin.get("/api/admin/pi-user-names");
const namesBody = await names.json().catch(() => null);
const nameOf = Object.fromEntries((namesBody?.users ?? []).map((u) => [u.id, u.name]));
const keyOf = Object.fromEntries((namesBody?.users ?? []).map((u) => [u.id, u.key]));
console.log(`  names: ${JSON.stringify(namesBody).slice(0, 300)}`);
check("U  Noah names both accounts for an admin (login name first, then the shown name)", names.status === 200 && nameOf[state.owner.id] === `@${state.owner.username} Owner E2E` && nameOf[state.second.id] === `@${state.second.username} Mate E2E`, JSON.stringify(nameOf));
check("U  …with the key pi names each one's sandbox by", /^u-[0-9a-f]{24}$/.test(keyOf[state.owner.id] ?? "") && keyOf[state.owner.id] !== keyOf[state.second.id], JSON.stringify(keyOf));
check("U  …and refuses a member", (await member.get("/api/admin/pi-user-names")).status === 403);

// ---------------------------------------------------------------------------------------------- the panel, in a browser
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" });
const [name, ...rest] = state.owner.cookie.split(";")[0].split("=");
await context.addCookies([{ name, value: rest.join("="), url: NOAH }]);
await context.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const tab = await context.newPage();
const problems = [];
tab.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
tab.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
tab.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
tab.on("response", (response) => response.status() >= 400 && problems.push(`http ${response.status()}: ${new URL(response.url()).pathname}`));

/** The elements of the page that show `id`, as the page has them now. */
const shown = (id) =>
  tab.evaluate((wanted) => {
    const out = [];
    for (const el of document.querySelectorAll("td, span, h1, h2, h3, h4, p, div")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("");
      if (!own.includes(wanted)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        text: own.trim(),
        attr: el.getAttribute("data-noah-user"),
        before: getComputedStyle(el, "::before").content,
      });
    }
    return out;
  }, id);

async function look(route, label, shot) {
  await tab.goto(`${NOAH}/admin/#/${route}`);
  await tab.locator(".page-head h1").waitFor({ timeout: 15_000 });
  await tab.waitForFunction((id) => document.body.innerText.includes(id), state.owner.id, { timeout: 15_000 }).catch(() => {});
  await tab.waitForFunction(() => document.querySelector("[data-noah-user]"), null, { timeout: 10_000 }).catch(() => {});
  const cells = await shown(state.owner.id);
  console.log(`  ${label}: ${JSON.stringify(cells).slice(0, 500)}`);
  const expected = nameOf[state.owner.id];
  check(`U  ${label}: every element showing the owner's id is marked with the owner's name`, cells.length > 0 && cells.every((c) => c.attr === expected), `${cells.length} element(s)`);
  check(`U  ${label}: the name is DRAWN before the id (::before), and the id text is still pi's`, cells.length > 0 && cells.every((c) => c.before.includes("Owner E2E") && c.text.includes(state.owner.id)), cells[0]?.before ?? "");
  await tab.screenshot({ path: `${W}/evidence/${shot}` });
  return cells;
}

await look("status", "상태 (사용자별 토큰)", "names-status.png");
await tab.locator("[data-noah-user]").first().scrollIntoViewIfNeeded();
await tab.screenshot({ path: `${W}/evidence/names-status-users.png` });
// pi polls the status every 10 s and redraws: the marks must still be right afterwards, not duplicated or stale.
await tab.waitForTimeout(11_000);
const after = await shown(state.owner.id);
check("U  상태: still marked after pi's own 10-second refresh", after.length > 0 && after.every((c) => c.attr === nameOf[state.owner.id]), `${after.length} element(s)`);
const others = await tab.evaluate(() => [...document.querySelectorAll("[data-noah-user]")].map((el) => `${el.textContent.trim().slice(0, 40)} => ${el.getAttribute("data-noah-user")}`));
console.log(`  every mark on 상태: ${JSON.stringify(others)}`);
check("U  상태: a mark is only ever on an element whose text is a user's id, a user's sandbox key or a consultation's", others.length > 0 && others.every((line) => /^[0-9a-f-]{36} => @\S+ .+$|^u-[0-9a-f]{24} => @\S+ .+$|^consult-[0-9a-f]{24} => 아바타 상담/.test(line)), others.join(" | "));
// The sandbox table shows pi's folder key, not the id: the owner's row is named, the container name next to it is not.
const sandbox = await shown(keyOf[state.owner.id]);
console.log(`  상태 (sandbox): ${JSON.stringify(sandbox)}`);
const keyCell = sandbox.filter((c) => c.text === keyOf[state.owner.id]);
const containerCell = sandbox.filter((c) => c.text !== keyOf[state.owner.id]);
check("U  상태 (sandbox): the owner's sandbox key is named, the container name that contains it is left alone", keyCell.length === 1 && keyCell[0].attr === nameOf[state.owner.id] && containerCell.every((c) => c.attr === null), `${keyCell.length} key cell(s), ${containerCell.length} other`);

await look("history", "대화 기록 (목록)", "names-history.png");
// One session: the line under the title names its user (`<span class="mono">` — not a table cell).
await tab.locator("tr.clickable", { hasText: state.owner.id }).first().click();
await tab.waitForFunction(() => /#\/history\/.+/.test(location.hash), null, { timeout: 10_000 });
await tab.waitForFunction(() => document.querySelector("span.mono[data-noah-user]"), null, { timeout: 10_000 }).catch(() => {});
const detail = (await shown(state.owner.id)).filter((c) => c.tag === "span");
console.log(`  대화 기록 (세션 하나): ${JSON.stringify(detail).slice(0, 400)}`);
check("U  대화 기록 (세션 하나): the session's user line is named too", detail.length > 0 && detail.every((c) => c.attr === nameOf[state.owner.id] && c.before.includes("Owner E2E")), `${detail.length} element(s)`);
await tab.screenshot({ path: `${W}/evidence/names-history-session.png` });
// A transcript is long text and tool output: an id inside it is left as it is.
const inTranscript = await tab.evaluate(() => [...document.querySelectorAll("pre [data-noah-user], code [data-noah-user], pre[data-noah-user], code[data-noah-user]")].length);
check("U  대화 기록 (세션 하나): nothing inside preformatted text is marked", inTranscript === 0, `${inTranscript}`);

// 요청 lists what pi kept (failed requests): rows exist only when something failed in this run.
await tab.goto(`${NOAH}/admin/#/requests`);
await tab.locator(".page-head h1").waitFor({ timeout: 15_000 });
await tab.waitForTimeout(1500);
const requests = await shown(state.owner.id);
console.log(`  (recorded, not judged) 요청: ${requests.length} element(s) show the owner's id${requests.length ? `, marked: ${requests.every((c) => c.attr === nameOf[state.owner.id])}` : ""}`);

const csps = await tab.evaluate(() => window.__csp);
check("U  no page error, failed request or CSP violation with Noah's script on pi's page", problems.length === 0 && csps.length === 0, [...problems, ...csps].join(" | "));
await browser.close();

finish();
