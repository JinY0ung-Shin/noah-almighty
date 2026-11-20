#!/usr/bin/env node
// H — the 대화 기록 list of pi's admin panel is a page of 20 since pi-gateway 2806c7a (2026-11-20; 50 since
// 7000e9c, the first 200 only before that). pi's commit ran its route test and never opened the page; no boot
// test had seen a SECOND page of any of the panel's lists (a fresh stack's lists fit the first).
// Looked at here, through Noah's /admin proxy against the real gateway, late in the run — when the earlier
// steps have left more than 20 sessions:
//   - the route: 20 per page, the total counted apart, the second page holding other sessions, an empty page past
//     the end, the `user` filter;
//   - the page in a real browser: 20 rows, the pager's text, 다음 pressed and the second page drawn.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { NOAH, W, check, client, finish, loadState, repoRequire, turn } from "./e2e-common.mjs";

const PAGE = 20;
const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const brief = (v, n = 300) => JSON.stringify(v).slice(0, n);
const history = async (query = "", c = admin) => {
  const res = await c.get(`/admin/api/history${query}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 200).replace(/\s+/g, " ") };
};

// ---------------------------------------------------------------------------------------------------------
// 1. the route
// ---------------------------------------------------------------------------------------------------------
let first = await history();
// Run alone on a young stack: make the sessions a second page needs (one turn of a new conversation each).
for (let i = first.json?.total ?? 0; i <= PAGE; i++) {
  await turn(admin, { avatarId: state.owner.id, conversationId: randomUUID(), message: `history page filler ${i}` });
}
first = await history();
const total = first.json?.total ?? -1;
const pages = Math.ceil(total / PAGE);
console.log(`  sessions in pi: ${total} → ${pages} page(s) of ${PAGE}`);
check(`H  GET /admin/api/history as a Noah admin → 200: ${PAGE} items, pageSize ${PAGE}, total ${total} (more than a page), no \`limit\``, first.status === 200 && first.json?.items?.length === PAGE && first.json.pageSize === PAGE && total > PAGE && !("limit" in first.json), `${first.status} items ${first.json?.items?.length} pageSize ${first.json?.pageSize} total ${total}`);
const second = await history("?page=2");
const firstIds = new Set((first.json?.items ?? []).map((s) => s.id));
const secondIds = (second.json?.items ?? []).map((s) => s.id);
check(`H  …?page=2 → the next ${Math.min(PAGE, total - PAGE)}: none of them on the first page, the same total`, second.status === 200 && secondIds.length === Math.min(PAGE, total - PAGE) && secondIds.every((id) => !firstIds.has(id)) && second.json.total === total && second.json.pageSize === PAGE, `items ${secondIds.length} total ${second.json?.total}`);
const order = [...(first.json?.items ?? []), ...(second.json?.items ?? [])].map((s) => String(s.lastActiveAt));
check("H  …most recent first across the two pages", order.length > PAGE && order.every((at, i) => i === 0 || order[i - 1] >= at), `${order[0]} … ${order.at(-1)}`);
const past = await history(`?page=${pages + 1}`);
check(`H  …?page=${pages + 1} (past the end) → 200 with no item and the same total`, past.status === 200 && past.json?.items?.length === 0 && past.json.total === total, past.text);
const odd = await history("?page=abc");
check("H  …?page=abc → the first page", odd.status === 200 && odd.json?.items?.[0]?.id === first.json?.items?.[0]?.id && odd.json.items.length === PAGE, `${odd.status} items ${odd.json?.items?.length}`);
const mine = await history(`?user=${encodeURIComponent(state.second.id)}`);
check("H  …?user=<the member's id> → only that user's sessions, counted apart, still pages of 20", mine.status === 200 && mine.json?.total < total && mine.json.items.length === Math.min(PAGE, mine.json.total) && mine.json.items.every((s) => s.user === state.second.id) && mine.json.pageSize === PAGE, `total ${mine.json?.total}, items ${mine.json?.items?.length}`);
const asMember = await history("?page=2", member);
check("H  …a member is refused (403)", asMember.status === 403, `${asMember.status} ${asMember.text}`);

// ---------------------------------------------------------------------------------------------------------
// 2. the page in a real browser, through Noah's /admin
// ---------------------------------------------------------------------------------------------------------
const { chromium } = repoRequire("playwright");
const SHOTS = `${W}/evidence/admin-ui`;
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" });
const [name, ...rest] = state.owner.cookie.split(";")[0].split("=");
await context.addCookies([{ name, value: rest.join("="), url: NOAH }]);
await context.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
page.on("response", (response) => response.status() >= 400 && problems.push(`http ${response.status()}: ${new URL(response.url()).pathname}`));
await page.goto(`${NOAH}/admin/#/history`);
const rows = page.locator("table.table").filter({ has: page.getByRole("columnheader", { name: "마지막 활동" }) }).locator("tbody tr");
const pager = page.locator("nav.pager");
const pagerText = async () => (await pager.innerText().catch(() => "")).replace(/\s+/g, " ");
// The session id is the row's last cell (the cell Noah's names never touch: it is not a user id).
const rowIds = async () => rows.locator("td:last-child").allInnerTexts();
await pager.getByText(`1 / ${pages}`).waitFor({ timeout: 15_000 }).catch(() => {});
// Sessions made since the route was read (this page's own load makes none) would move the numbers: read them now.
const shownTotal = (await history()).json?.total;
const shownPages = Math.ceil(shownTotal / PAGE);
const page1 = await rowIds();
let text = await pagerText();
await page.screenshot({ path: `${SHOTS}/history-page-1.png`, fullPage: true });
check(`H  the 대화 기록 page shows ${PAGE} rows and "1–${PAGE} / 전체 ${shownTotal}개 … 1 / ${shownPages}", 처음 and 이전 disabled, 다음 and 끝 enabled`,
  page1.length === PAGE && text.includes(`1–${PAGE} / 전체 ${shownTotal}개`) && text.includes(`1 / ${shownPages}`) &&
    (await pager.getByRole("button", { name: "처음" }).isDisabled()) && (await pager.getByRole("button", { name: "이전" }).isDisabled()) &&
    (await pager.getByRole("button", { name: "다음" }).isEnabled()) && (await pager.getByRole("button", { name: "끝" }).isEnabled()),
  `${page1.length} rows · ${text}`);
await pager.getByRole("button", { name: "다음" }).click();
await pager.getByText(`2 / ${shownPages}`).waitFor({ timeout: 10_000 }).catch(() => {});
const page2 = await rowIds();
text = await pagerText();
const upTo = Math.min(2 * PAGE, shownTotal);
await page.screenshot({ path: `${SHOTS}/history-page-2.png`, fullPage: true });
check(`H  다음 pressed: ${upTo - PAGE} other rows and "${PAGE + 1}–${upTo} / 전체 ${shownTotal}개 … 2 / ${shownPages}", 처음 and 이전 enabled`,
  page2.length === upTo - PAGE && page2.every((id) => !page1.includes(id)) && text.includes(`${PAGE + 1}–${upTo} / 전체 ${shownTotal}개`) && text.includes(`2 / ${shownPages}`) &&
    (await pager.getByRole("button", { name: "처음" }).isEnabled()) && (await pager.getByRole("button", { name: "이전" }).isEnabled()),
  `${page2.length} rows · ${text}`);
// A row of the second page opens its session.
const opened = page2[0];
await rows.first().click();
let openedOk = true;
await page.waitForURL((url) => url.hash === `#/history/${encodeURIComponent(opened)}`, { timeout: 10_000 }).catch(() => { openedOk = false; });
check("H  a row of the second page opens that session (#/history/<its id>)", openedOk, `${new URL(page.url()).hash} for ${opened}`);
const csp = await page.evaluate(() => window.__csp);
check("H  …with no page error, failed call or CSP violation", problems.length === 0 && csp.length === 0, brief({ problems, csp }));
await browser.close();

finish();
