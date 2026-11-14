#!/usr/bin/env node
// P — pi 08d35cb (2026-11-14): refreshing a marketplace reinstalls the plugins that have a new version, and the
// gateway refreshes every marketplace once an hour. pi's own tests drive the service in-process; this is the
// real stack, through Noah's /admin proxy: gateway → git (smart HTTP, a fixture marketplace) → install → what a
// Noah conversation is told. The panel's notice (which pi's commit did not look at) is read in a real browser.
// It ends by leaving ONE new version unfetched for 89-plugin-timer.mjs (the hourly refresh).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { NOAH, W, check, client, dind, fake, finish, loadState, repoRequire, saveState, turn } from "./e2e-common.mjs";

const GIT = "http://10.217.0.12:18093";
const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const RUN = Date.now().toString(36);
const SHOTS = `${W}/evidence/admin-ui`;
mkdirSync(SHOTS, { recursive: true });

async function api(method, path, body, who = admin) {
  const res = await who.request(`/admin/api${path}`, { method, headers: PANEL, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}
const fx = {
  state: async () => (await fetch(`${GIT}/_state`)).json(),
  set: async (plugin, version, broken = false) => (await fetch(`${GIT}/_set`, { method: "POST", body: JSON.stringify({ plugin, version, broken }) })).json(),
};
const plugins = async () => Object.fromEntries(((await api("GET", "/plugins")).json?.plugins ?? []).map((p) => [p.id, p]));
const refresh = () => api("POST", "/marketplaces/bootmk/refresh", {});
const brief = (p) => (p ? `${p.id} v${p.version}${p.update ? ` (update → ${p.update.version})` : ""}` : "(none)");

/** One plain turn of a conversation; returns the BOOTMK markers the model's request carried. */
async function markersOf(conversationId, label) {
  const key = `plug-${RUN}-${conversationId.slice(0, 8)}`; // the fake LLM routes by the first marker: one key per conversation
  const t = await turn(admin, { avatarId: state.owner.id, conversationId, message: `안녕 (${label}) [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const body = JSON.stringify(reqs.at(-1)?.body ?? {});
  const ok = t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0;
  if (!ok) console.log(`  [${label}] status ${t.status} ${JSON.stringify(t.json ?? t.of("error")).slice(0, 300)}`);
  return { ok, markers: [...new Set(body.match(/BOOTMK-[a-z]+-\d+\.\d+\.\d+/g) ?? [])].sort().join(" ") };
}

// ---------------------------------------------------------------------------------------------------------
// 0. add the marketplace, install two plugins
// ---------------------------------------------------------------------------------------------------------
let r = await api("POST", "/marketplaces", { url: `${GIT}/mk` });
let head = (await fx.state()).head;
check("P  POST /admin/api/marketplaces (an http git URL) through Noah's proxy → 201 at the repository's HEAD", r.status === 201 && r.json?.name === "bootmk" && r.json?.commitSha === head, `${r.status} ${r.text}`);
for (const name of ["alpha", "beta"]) {
  r = await api("POST", "/plugins/install", { marketplace: "bootmk", plugin: name });
  check(`P  install ${name} → 201 v1.0.0 with its skill`, r.status === 201 && r.json?.plugin?.version === "1.0.0" && r.json.plugin.components.skills.length === 1, `${r.status} ${r.text.slice(0, 200)}`);
}
let before = await plugins();

// ---------------------------------------------------------------------------------------------------------
// 1. a refresh with nothing new changes nothing
// ---------------------------------------------------------------------------------------------------------
r = await refresh();
let now = await plugins();
check(
  "P  a refresh with nothing new: 200, updated [] and warnings [], no plugin reinstalled",
  r.status === 200 && Array.isArray(r.json?.updated) && r.json.updated.length === 0 && r.json.warnings.length === 0 && ["alpha@bootmk", "beta@bootmk"].every((id) => now[id]?.updatedAt === before[id]?.updatedAt && now[id]?.version === "1.0.0"),
  `${r.status} ${JSON.stringify({ updated: r.json?.updated, warnings: r.json?.warnings })}`,
);
r = await api("POST", "/marketplaces/bootmk/refresh", {}, member);
check("P  a non-admin member cannot refresh (never 200)", r.status !== 200, `${r.status} ${r.text.slice(0, 120)}`);

// ---------------------------------------------------------------------------------------------------------
// 2. a new version in the repository: the refresh itself installs it
// ---------------------------------------------------------------------------------------------------------
head = (await fx.set("alpha", "1.1.0")).head;
now = await plugins();
check("P  before any refresh the gateway does not know: alpha stays v1.0.0 with no update badge", now["alpha@bootmk"]?.version === "1.0.0" && !now["alpha@bootmk"]?.update, brief(now["alpha@bootmk"]));
before = now;
r = await refresh();
now = await plugins();
check(
  'P  refresh → updated ["alpha@bootmk v1.1.0"], the marketplace at the new commit',
  r.status === 200 && JSON.stringify(r.json?.updated) === '["alpha@bootmk v1.1.0"]' && r.json.commitSha === head && r.json.warnings.length === 0,
  `${r.status} ${JSON.stringify({ updated: r.json?.updated, warnings: r.json?.warnings, commit: r.json?.commitSha?.slice(0, 7) })}`,
);
check("P  alpha is v1.1.0 with no update left; beta was not touched", now["alpha@bootmk"]?.version === "1.1.0" && !now["alpha@bootmk"]?.update && now["beta@bootmk"]?.version === "1.0.0" && now["beta@bootmk"]?.updatedAt === before["beta@bootmk"]?.updatedAt, `${brief(now["alpha@bootmk"])}; ${brief(now["beta@bootmk"])}`);
r = await api("GET", `/plugins/${encodeURIComponent("alpha@bootmk")}/skills/${encodeURIComponent("alpha:alpha-skill")}`);
check("P  the installed skill is the new version's text", r.status === 200 && String(r.json?.content ?? "").includes("BOOTMK-alpha-1.1.0"), `${r.status} ${r.text.slice(0, 160)}`);

const convA = randomUUID();
const a1 = await markersOf(convA, "A1");
check("P  a NEW Noah conversation is told the updated skill (alpha 1.1.0, beta 1.0.0)", a1.ok && a1.markers === "BOOTMK-alpha-1.1.0 BOOTMK-beta-1.0.0", a1.markers || "(no marker in the model's request)");

// ---------------------------------------------------------------------------------------------------------
// 3. the panel: one more version, and a plugin that cannot be installed — pressed in a real browser
// ---------------------------------------------------------------------------------------------------------
await fx.set("alpha", "1.2.0");
head = (await fx.set("beta", "1.1.0", true)).head; // an unreadable plugin.json
const { chromium } = repoRequire("playwright");
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ko-KR" });
const [cookieName, ...cookieRest] = state.owner.cookie.split(";")[0].split("=");
await context.addCookies([{ name: cookieName, value: cookieRest.join("="), url: NOAH }]);
await context.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("response", (response) => response.status() >= 400 && problems.push(`http ${response.status()}: ${new URL(response.url()).pathname}`));
await page.goto(`${NOAH}/admin/#/plugins`);
await page.locator(".page-head h1").waitFor({ timeout: 15_000 });
const button = page.locator("tr", { hasText: "bootmk" }).getByRole("button", { name: "새로고침", exact: true });
await button.waitFor({ timeout: 15_000 });
const pageText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
check("P  [panel] the page says a refresh updates at once and that the gateway refreshes every hour", (await pageText()).includes("새 버전이 있는 plugin을 바로 업데이트합니다. gateway도 1시간마다 새로고침합니다"));
await button.click();
const notice = page.getByText(/bootmk을\(를\) 새로고침/).first();
await notice.waitFor({ timeout: 60_000 });
let noticeText = (await notice.innerText()).replace(/\s+/g, " ");
console.log("  notice:", noticeText);
check("P  [panel] the notice names what was updated: alpha@bootmk v1.2.0", noticeText.includes("bootmk을(를) 새로고침하고 alpha@bootmk v1.2.0을(를) 업데이트했습니다"));
check("P  [panel] …and what could not be: beta@bootmk is left as it was, with the reason", noticeText.includes("확인할 점:") && noticeText.includes("beta@bootmk: 다시 설치하지 못해 그대로 둡니다"));
await page.waitForTimeout(400);
let text = await pageText();
check("P  [panel] beta keeps an '업데이트 있음' badge; alpha shows v1.2.0", /업데이트 있음 v[0-9a-f]{12}/.test(text) && text.includes("1.2.0"), (/업데이트 있음 v\S+/.exec(text) ?? ["(no badge)"])[0]);
await page.screenshot({ path: `${SHOTS}/plugins-refresh-updated.png`, fullPage: true });
await button.click();
const again = page.getByText(/새로고침했습니다 \(새 버전 없음\)/).first();
await again.waitFor({ timeout: 60_000 });
noticeText = (await again.innerText()).replace(/\s+/g, " ");
console.log("  notice:", noticeText);
check("P  [panel] pressing again: '새 버전 없음', and the plugin that still cannot be installed is named again", noticeText.includes("beta@bootmk: 다시 설치하지 못해 그대로 둡니다"));
await page.screenshot({ path: `${SHOTS}/plugins-refresh-nothing-new.png`, fullPage: true });
const csp = await page.evaluate(() => window.__csp);
check("P  [panel] no page error, failed request or CSP violation", problems.length === 0 && csp.length === 0, JSON.stringify({ problems, csp }));
await browser.close();

now = await plugins();
check("P  alpha is v1.2.0; beta is still the v1.0.0 that was installed, marked as having an update", now["alpha@bootmk"]?.version === "1.2.0" && now["beta@bootmk"]?.version === "1.0.0" && Boolean(now["beta@bootmk"]?.update), `${brief(now["alpha@bootmk"])}; ${brief(now["beta@bootmk"])}`);
r = await api("GET", `/plugins/${encodeURIComponent("beta@bootmk")}/skills/${encodeURIComponent("beta:beta-skill")}`);
check("P  beta's installed skill is still readable and still the old text", r.status === 200 && String(r.json?.content ?? "").includes("BOOTMK-beta-1.0.0"), `${r.status} ${r.text.slice(0, 120)}`);

// ---------------------------------------------------------------------------------------------------------
// 4. a conversation already going keeps what it was told; a new one gets the new version
// ---------------------------------------------------------------------------------------------------------
const a2 = await markersOf(convA, "A2");
check("P  the conversation that started at alpha 1.1.0 is still told 1.1.0 on its next turn (its prompt is not rewritten)", a2.ok && a2.markers === "BOOTMK-alpha-1.1.0 BOOTMK-beta-1.0.0", a2.markers || "(no marker)");
const b1 = await markersOf(randomUUID(), "B1");
check("P  a new conversation is told alpha 1.2.0 (and beta 1.0.0)", b1.ok && b1.markers === "BOOTMK-alpha-1.2.0 BOOTMK-beta-1.0.0", b1.markers || "(no marker)");

// ---------------------------------------------------------------------------------------------------------
// 5. Noah's audit log, the gateway's log
// ---------------------------------------------------------------------------------------------------------
const audit = (await (await admin.get("/api/audit")).json()).audit ?? [];
const rows = audit.filter((e) => e.action === "pi_admin_proxy" && e.detail.startsWith("POST /admin/api/marketplaces/bootmk/refresh"));
check("P  every refresh pressed through Noah is an audit row `pi_admin_proxy`", rows.length >= 4, `${rows.length} row(s): ${rows[0]?.detail ?? ""} [${[...new Set(rows.map((e) => e.status))].join(",")}]`);
const log = dind("docker", "logs", "noah-almighty-gateway-1");
const lines = log.split("\n").filter((l) => l.includes("bootmk"));
console.log(`  gateway log lines naming bootmk: ${lines.length}; e.g. ${lines.at(-1)?.slice(0, 220)}`);
check("P  the gateway's log has the refreshes and installs, and no git URL credentials or file content", lines.some((l) => l.includes("marketplace refreshed")) && lines.some((l) => l.includes("plugin installed")) && !log.includes("BOOTMK-"));

// ---------------------------------------------------------------------------------------------------------
// 6. leave one new version unfetched for the hourly refresh (89-plugin-timer.mjs)
// ---------------------------------------------------------------------------------------------------------
const pending = await fx.set("alpha", "1.3.0");
const fxState = await fx.state();
const gatewayStartedAt = dind("docker", "inspect", "-f", "{{.State.StartedAt}}", "noah-almighty-gateway-1").trim();
now = await plugins();
check("P  alpha 1.3.0 is committed in the repository and NOT refreshed: the gateway still has v1.2.0", now["alpha@bootmk"]?.version === "1.2.0" && !now["alpha@bootmk"]?.update, brief(now["alpha@bootmk"]));
saveState({ ...loadState(), pluginTimer: { pendingHead: pending.head, pendingSetAt: new Date().toISOString(), fetches: fxState.fetches.length, gatewayStartedAt } });
console.log(`  gateway started ${gatewayStartedAt}; its first hourly refresh is due about ${new Date(Date.parse(gatewayStartedAt) + 3_600_000).toISOString()}`);
finish();
