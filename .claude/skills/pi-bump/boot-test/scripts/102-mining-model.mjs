#!/usr/bin/env node
// K — the model a process-mining run uses, as it is since pi-gateway 2bca2c2 (2026-11-20): the 프로세스 마이닝
// page has a 모델 select (the models and tiers of `/chat/options`; unpicked = pi's default model), the choice is
// a row in mining.db (`PUT /admin/api/mining/model`), and a run whose chosen model is gone from pi's LLM settings
// ends 실패 instead of falling back to the default. The same commit drops the 2,000-token output cap of a mining
// call: it now sends the model's own maxTokens.
// pi's tests cover the route against an in-process gateway and `openModel` against a database file; they do not
// start the mining service's run process, and the page was not opened against a real gateway.
// Looked at here, through Noah's /admin proxy as a Noah admin and in a real browser:
//   - the route (who may call it, what it refuses, a tier accepted);
//   - the select on the page: what it lists, a model picked there and the run that then uses it;
//   - that model removed from pi's LLM settings: what the page shows, and the run that follows — 실패 with a reason
//     an admin can act on, no silent fall-back;
//   - back to 기본 모델: a run completes on the default again.
// A fresh stack has no session that rested 30 minutes, so every run here reads NOTHING and calls no model: the
// request a run sends — and so `max_tokens` = the model's maxTokens — is NOT seen (it rests on pi's mining.test.ts).
// The 실패 run writes ONE error-level line to the mining service's log; 95-final-state.sh and 98-mining.mjs know
// that line (`EXPECTED_MINING_ERROR` there) and count every other one.
// Run alone it needs a stack younger than 30 minutes (like 98-mining.mjs): later a run reads sessions the fake LLM
// cannot answer and ends 중단.
// Leaves pi's LLM settings and the mining model as it found them (fake-model only, falcon tier; no model picked).
import { mkdirSync } from "node:fs";
import { FAKE, NOAH, W, check, client, dindTry, finish, loadState, repoRequire } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const MINING_C = "noah-almighty-mining-1";
const GATEWAY_C = "noah-almighty-gateway-1";
const PICKED = "fake-mining";
const GONE = `마이닝에 고른 모델 ${PICKED}이 LLM 설정에 없다 (관리 화면의 프로세스 마이닝에서 다시 고른다)`;
const brief = (v, n = 300) => JSON.stringify(v).slice(0, n);
const note = (label, text) => console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (res) => {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300).replace(/\s+/g, " ") };
};
const overview = async (c = admin) => call(await c.get("/admin/api/mining"));
const runList = async () => call(await admin.get("/admin/api/mining/runs"));
const putModel = async (model, c = admin, headers = PANEL) => call(await c.put("/admin/api/mining/model", { model }, headers));
const options = async () => call(await admin.get("/admin/api/chat/options"));
const fakeModel = (id) => ({ id, contextWindow: 131072, maxTokens: 4096, input: ["text", "image"] });
// The stack's LLM settings (04-fake-llm.sh), with `extra` models on the same fake server.
const llmSettings = (...extra) => ({ defaultModel: "fake-model", tiers: { falcon: "fake-model" }, servers: [{ id: "fake", api: "openai-completions", baseUrl: `${FAKE}/v1`, apiKey: "", models: [fakeModel("fake-model"), ...extra.map(fakeModel)] }] });
const putLlm = async (...extra) => call(await admin.put("/admin/api/llm", llmSettings(...extra), PANEL));
/** Wait until no run is requested or running; the overview then. */
const settled = async () => {
  let o = await overview();
  for (let i = 0; i < 45 && o.json?.active; i++) {
    await sleep(1000);
    o = await overview();
  }
  return o;
};
/** Request a run through the API and wait for its end; the run's row. */
const runOnce = async () => {
  await settled();
  const asked = await call(await admin.post("/admin/api/mining/run", {}, PANEL));
  const id = (await runList()).json?.items?.[0]?.id;
  await settled();
  const row = (await runList()).json?.items?.find((r) => r.id === id);
  return { asked, row };
};

// ---------------------------------------------------------------------------------------------------------
// 1. the route through Noah's /admin proxy
// ---------------------------------------------------------------------------------------------------------
let now = await settled();
check("K  GET /admin/api/mining carries `model`, null on a stack where nobody picked one", now.status === 200 && "model" in (now.json ?? {}) && now.json.model === null, brief({ model: now.json?.model }));
let opts = await options();
const listed = () => (opts.json?.models ?? []).map((m) => m.id);
note("GET /admin/api/chat/options (models, defaultModel)", `${listed().join(", ")} · default ${opts.json?.defaultModel}`);
check("K  the models the page offers come from /admin/api/chat/options: fake-model and the falcon tier, default fake-model", opts.status === 200 && listed().includes("fake-model") && listed().includes("falcon") && opts.json.defaultModel === "fake-model", `${opts.status} ${listed().join(", ")}`);
let res = await putModel("no-such-model");
check("K  PUT /admin/api/mining/model {model: \"no-such-model\"} → 400 invalid_model, still null", res.status === 400 && res.json?.error?.code === "invalid_model" && (await overview()).json?.model === null, `${res.status} ${res.text}`);
res = await putModel(7);
check("K  …{model: 7} → 400 invalid_model", res.status === 400 && res.json?.error?.code === "invalid_model", `${res.status} ${res.text}`);
res = await putModel("fake-model", admin, {});
check("K  …{model: \"fake-model\"} WITHOUT the panel headers → 403, still null", res.status === 403 && (await overview()).json?.model === null, `${res.status} ${res.text}`);
res = await putModel("fake-model", member);
check("K  …a member's PUT with the panel headers → 403, still null", res.status === 403 && (await overview()).json?.model === null, `${res.status} ${res.text}`);
res = await putModel("falcon");
now = await overview();
check("K  …{model: \"falcon\"} (a TIER) as a Noah admin → 200 {model: \"falcon\"} and GET shows it", res.status === 200 && res.json?.model === "falcon" && now.json?.model === "falcon", `${res.status} ${res.text}; GET model ${brief(now.json?.model)}`);
res = await putModel(null);
now = await overview();
check("K  …{model: null} → 200 {model: null}: back to the default", res.status === 200 && res.json?.model === null && now.json?.model === null, `${res.status} ${res.text}`);

// A second model on the same fake server, so a pick can be told from the default in a run's row.
res = await putLlm(PICKED);
opts = await options();
check(`K  a second model (${PICKED}) saved on pi's LLM page is offered at once`, res.status === 200 && listed().includes(PICKED), `${res.status} ${listed().join(", ")}`);

// ---------------------------------------------------------------------------------------------------------
// 2. the select on the page, in a real browser through Noah's /admin
// ---------------------------------------------------------------------------------------------------------
const { chromium } = repoRequire("playwright");
const SHOTS = `${W}/evidence/admin-ui`;
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" });
const [cookieName, ...rest] = state.owner.cookie.split(";")[0].split("=");
await context.addCookies([{ name: cookieName, value: rest.join("="), url: NOAH }]);
await context.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
page.on("response", (response) => response.status() >= 400 && problems.push(`http ${response.status()}: ${new URL(response.url()).pathname}`));
const select = page.locator("#mining-model");
const optionTexts = async () => (await select.locator("option").allInnerTexts().catch(() => [])).map((t) => t.trim());
const selectedText = async () => (await select.evaluate((el) => el.selectedOptions[0]?.textContent ?? "").catch(() => "(no select)")).trim();
const runRows = page.locator("table.table").filter({ has: page.getByRole("columnheader", { name: "계기" }) }).locator("tbody tr");
await page.goto(`${NOAH}/admin/#/mining`);
// The select is disabled until /chat/options has answered.
await select.locator(`option[value="${PICKED}"]`).waitFor({ state: "attached", timeout: 15_000 }).catch((error) => note("page", String(error).slice(0, 300)));
let texts = await optionTexts();
note("the 모델 select", `${texts.join(" | ")} · selected: ${await selectedText()}`);
check(
  `K  the page's 모델 select: "기본 모델 (fake-model)" selected, then every model and tier of /chat/options (${listed().join(", ")}), with "작업을 뽑고 프로세스로 분류하는 데 쓰는 모델입니다. 다음 실행부터 적용됩니다."`,
  (await selectedText()) === "기본 모델 (fake-model)" && texts[0] === "기본 모델 (fake-model)" && brief(texts.slice(1)) === brief(listed()) && (await select.isEnabled().catch(() => false)) &&
    (await page.getByText("작업을 뽑고 프로세스로 분류하는 데 쓰는 모델입니다. 다음 실행부터 적용됩니다.").count()) === 1,
  texts.join(" | "),
);
let savedSaid = true;
await select.selectOption(PICKED).catch((error) => note("select", String(error).slice(0, 200)));
await page.getByText("저장했습니다. 다음 실행부터 적용됩니다.").waitFor({ timeout: 10_000 }).catch(() => { savedSaid = false; });
now = await overview();
check(`K  ${PICKED} picked there: the page says "저장했습니다. 다음 실행부터 적용됩니다." and GET shows model ${PICKED}`, savedSaid && now.json?.model === PICKED && (await selectedText()) === PICKED, `GET model ${brief(now.json?.model)} · selected ${await selectedText()}`);
await page.screenshot({ path: `${SHOTS}/mining-model-picked.png`, fullPage: true });

// ---------------------------------------------------------------------------------------------------------
// 3. the run that uses it
// ---------------------------------------------------------------------------------------------------------
let run = await runOnce();
note("the run with a picked model", brief(run.row, 500));
check(`K  a run after the pick ends 완료 on ${PICKED} — the run process read the choice from mining.db and that model from pi's LLM settings`, run.asked.status === 200 && run.row?.status === "completed" && run.row.error === null && run.row.model === PICKED, brief({ asked: run.asked.status, status: run.row?.status, model: run.row?.model, error: run.row?.error }));
if (run.row && run.row.processed !== 0) console.log(`  (recorded, not judged) this run read ${run.row.processed} session(s): the stack is older than 30 minutes`);

// ---------------------------------------------------------------------------------------------------------
// 4. the picked model removed from pi's LLM settings
// ---------------------------------------------------------------------------------------------------------
res = await putLlm();
opts = await options();
now = await overview();
check(`K  ${PICKED} removed on pi's LLM page: /chat/options no longer lists it, and the mining choice STAYS ${PICKED} (nothing resets it)`, res.status === 200 && !listed().includes(PICKED) && now.json?.model === PICKED, `${res.status} ${listed().join(", ")}; GET model ${brief(now.json?.model)}`);
await page.reload();
await select.locator('option[value="fake-model"]').waitFor({ state: "attached", timeout: 15_000 }).catch((error) => note("page", String(error).slice(0, 300)));
texts = await optionTexts();
check(`K  …the page shows the choice as "${PICKED} (LLM 설정에 없음)", still selected`, (await selectedText()) === `${PICKED} (LLM 설정에 없음)` && texts.includes(`${PICKED} (LLM 설정에 없음)`), `${texts.join(" | ")} · selected: ${await selectedText()}`);
run = await runOnce();
note("the run with a model that is gone", brief(run.row, 500));
check("K  a run then ends 실패 with the reason, and on NO model — it does not fall back to the default", run.asked.status === 200 && run.row?.status === "failed" && run.row.error === GONE && run.row.model === null && run.row.processed === null,
  brief({ asked: run.asked.status, status: run.row?.status, model: run.row?.model, processed: run.row?.processed, error: run.row?.error }));
now = await overview();
check("K  …the overview has it as `last`, nothing active, and the service is still up (a later request is taken — below)", now.json?.active === null && now.json.last?.id === run.row?.id && now.json.last.status === "failed", brief({ active: now.json?.active, last: now.json?.last?.status }));
await page.reload();
let rowText = "";
try {
  await runRows.first().getByText("실패").waitFor({ timeout: 15_000 });
  rowText = (await runRows.first().innerText()).replace(/\s+/g, " ");
} catch (error) {
  note("page after the failed run", String(error).slice(0, 300));
}
const lastStat = (await page.locator(".stats").first().innerText().catch(() => "")).replace(/\s+/g, " ");
await page.screenshot({ path: `${SHOTS}/mining-model-gone.png`, fullPage: true });
check(`K  the page's 실행 이력 shows that run first — 수동, 실패, "${GONE}" — and 마지막 실행 실패 on top`, /수동/.test(rowText) && /실패/.test(rowText) && rowText.includes(GONE) && /마지막 실행 실패/.test(lastStat), `${rowText.slice(0, 220)} · ${lastStat.slice(0, 120)}`);

// ---------------------------------------------------------------------------------------------------------
// 5. back to the default, on the page
// ---------------------------------------------------------------------------------------------------------
savedSaid = true;
await select.selectOption("").catch((error) => note("select", String(error).slice(0, 200)));
await page.getByText("저장했습니다. 다음 실행부터 적용됩니다.").waitFor({ timeout: 10_000 }).catch(() => { savedSaid = false; });
now = await overview();
texts = await optionTexts();
check("K  기본 모델 picked on the page: saved, GET shows null, and the gone model is no longer an option", savedSaid && now.json?.model === null && (await selectedText()) === "기본 모델 (fake-model)" && !texts.some((t) => t.startsWith(PICKED)), `GET model ${brief(now.json?.model)} · ${texts.join(" | ")}`);
run = await runOnce();
check("K  …and the next run ends 완료 on fake-model again", run.row?.status === "completed" && run.row.error === null && run.row.model === "fake-model", brief({ status: run.row?.status, model: run.row?.model, error: run.row?.error }));
const csp = await page.evaluate(() => window.__csp).catch(() => ["(page gone)"]);
check("K  …with no page error, failed call or CSP violation", problems.length === 0 && csp.length === 0, brief({ problems, csp }));
await browser.close();

// ---------------------------------------------------------------------------------------------------------
// 6. what is left behind, and the logs
// ---------------------------------------------------------------------------------------------------------
const llmNow = await call(await admin.get("/admin/api/llm"));
const modelsNow = (llmNow.json?.settings ?? llmNow.json)?.servers?.flatMap((s) => s.models.map((m) => m.id)) ?? [];
check("K  left as found: pi's LLM settings hold fake-model only with the falcon tier, no mining model picked", brief(modelsNow) === brief(["fake-model"]) && (llmNow.json?.settings ?? llmNow.json)?.tiers?.falcon === "fake-model" && (await overview()).json?.model === null, `${llmNow.status} models ${modelsNow.join(", ")}`);
const log = dindTry("sh", "-c", `docker logs ${MINING_C} 2>&1`).out;
const errorLines = log.split("\n").filter((l) => /"level":(50|60)/.test(l));
note("error-level lines in the mining log", errorLines.join("\n").slice(0, 900) || "(none)");
check("K  the mining log's error-level lines are that reason and nothing else (one per 실패 run)", errorLines.length >= 1 && errorLines.every((l) => l.includes(`"msg":"${GONE}"`)), `${errorLines.length} line(s)`);
const gatewayLog = dindTry("sh", "-c", `docker logs ${GATEWAY_C} 2>&1`).out.split("\n").filter((l) => /mining model updated/.test(l));
note("gateway log: mining model updated", gatewayLog.slice(-6).join("\n").slice(0, 900) || "(none)");
check("K  the gateway logged each change of the model (\"mining model updated\") at info", gatewayLog.length >= 4 && gatewayLog.every((l) => /"level":30/.test(l)) && gatewayLog.some((l) => l.includes(`"model":"${PICKED}"`)) && gatewayLog.some((l) => l.includes('"model":null')), `${gatewayLog.length} line(s)`);

finish();
