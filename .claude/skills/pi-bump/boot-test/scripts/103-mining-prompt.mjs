#!/usr/bin/env node
// Y — the operator's extra system prompt for process mining, as it is since pi-gateway 71011f6 (2026-11-20): the
// 프로세스 마이닝 page has a 추가 프롬프트 row (없음 / N자, 편집 opens a dialog), the text is a row in mining.db
// (`PUT /admin/api/mining/prompt`, 4,000 characters at most, blank = none) and a run appends it to the system
// prompt of EVERY LLM call it makes ("Additional instructions from the operator:"), from the next run on.
// pi's tests cover the route on an in-process gateway and the composed system prompt on a scripted server; the
// dialog was not opened on a real gateway and the service's run process was not started with a prompt set.
// Looked at here, through Noah's /admin proxy as a Noah admin and in a real browser:
//   - the route (who may call it, what it refuses, trimming, blank and null);
//   - the row and the dialog: a text typed and saved, shown again after a reload, cleared;
//   - a run with a prompt set (the run process reads it from mining.db and still ends 완료);
//   - the gateway's log: each change with a character count, never the text.
// A fresh stack has no session that rested 30 minutes, so the run reads NOTHING and calls no model: the system
// prompt a mining call carries is NOT seen here (it rests on pi's mining.test.ts).
// Run alone it needs a stack younger than 30 minutes (like 98-mining.mjs). Leaves no prompt set.
import { mkdirSync } from "node:fs";
import { NOAH, W, check, client, dindTry, finish, loadState, repoRequire } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const GATEWAY_C = "noah-almighty-gateway-1";
const MINING_C = "noah-almighty-mining-1";
// Words no other log line holds, so "the text is not in the log" means something.
const TEXT = "프로세스 이름은 한국어 명사구로 짓는다. 사내 용어 zqx-품의 = 결재 요청.";
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
const putPrompt = async (prompt, c = admin, headers = PANEL) => call(await c.put("/admin/api/mining/prompt", { prompt }, headers));
/** Wait until no run is requested or running; the overview then. */
const settled = async () => {
  let o = await overview();
  for (let i = 0; i < 45 && o.json?.active; i++) {
    await sleep(1000);
    o = await overview();
  }
  return o;
};

// ---------------------------------------------------------------------------------------------------------
// 1. the route through Noah's /admin proxy
// ---------------------------------------------------------------------------------------------------------
let now = await settled();
check("Y  GET /admin/api/mining carries `prompt`, null on a stack where nobody wrote one", now.status === 200 && "prompt" in (now.json ?? {}) && now.json.prompt === null, brief({ prompt: now.json?.prompt }));
let res = await putPrompt("x".repeat(4001));
check("Y  PUT /admin/api/mining/prompt with 4,001 characters → 400 invalid_prompt, still null", res.status === 400 && res.json?.error?.code === "invalid_prompt" && (await overview()).json?.prompt === null, `${res.status} ${res.text}`);
res = await putPrompt(7);
check("Y  …{prompt: 7} → 400 invalid_prompt", res.status === 400 && res.json?.error?.code === "invalid_prompt", `${res.status} ${res.text}`);
res = await putPrompt(TEXT, admin, {});
check("Y  …a text WITHOUT the panel headers → 403, still null", res.status === 403 && (await overview()).json?.prompt === null, `${res.status} ${res.text}`);
res = await putPrompt(TEXT, member);
check("Y  …a member's PUT with the panel headers → 403, still null", res.status === 403 && (await overview()).json?.prompt === null, `${res.status} ${res.text}`);
res = await putPrompt(`  ${TEXT}\n `);
now = await overview();
check("Y  …a text with blanks around it as a Noah admin → 200 with the text TRIMMED, and GET shows it", res.status === 200 && res.json?.prompt === TEXT && now.json?.prompt === TEXT, `${res.status} ${res.text}`);
res = await putPrompt("가".repeat(4000));
check("Y  …4,000 characters exactly → 200", res.status === 200 && res.json?.prompt?.length === 4000 && (await overview()).json?.prompt?.length === 4000, `${res.status} length ${res.json?.prompt?.length}`);
res = await putPrompt("   ");
now = await overview();
check("Y  …a blank text → 200 {prompt: null}: none again", res.status === 200 && res.json?.prompt === null && now.json?.prompt === null, `${res.status} ${res.text}`);
res = await putPrompt(null);
check("Y  …{prompt: null} → 200 {prompt: null}", res.status === 200 && res.json?.prompt === null, `${res.status} ${res.text}`);

// ---------------------------------------------------------------------------------------------------------
// 2. the row and the dialog, in a real browser through Noah's /admin
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
const row = page.locator("div.row").filter({ has: page.getByRole("button", { name: "편집", exact: true }) }).filter({ hasText: "추가 프롬프트" }).last();
const rowText = async () => (await row.innerText().catch(() => "(no row)")).replace(/\s+/g, " ").trim();
const dialog = page.locator("dialog.modal[open]");
const area = dialog.locator("textarea");
const save = dialog.getByRole("button", { name: "저장", exact: true });
// The dialog's own × — the "저장했습니다" notice inside it has a 닫기 button too.
const closeButton = dialog.locator("button.modal-close");
const counter = async () => ((await dialog.innerText().catch(() => "")).match(/[\d,]+ \/ [\d,]+자/) ?? ["(no counter)"])[0];
const SAVED = "저장했습니다. 다음 실행부터 적용됩니다.";
await page.goto(`${NOAH}/admin/#/mining`);
await row.waitFor({ timeout: 15_000 }).catch((error) => note("page", String(error).slice(0, 300)));
let text = await rowText();
check('Y  the page has a 추가 프롬프트 row: "없음", a 편집 button, "세션 읽기·분류·검토·대표 흐름의 모든 호출에서 시스템 프롬프트 끝에 붙습니다. 다음 실행부터 적용됩니다."',
  text === "추가 프롬프트 없음 편집 세션 읽기·분류·검토·대표 흐름의 모든 호출에서 시스템 프롬프트 끝에 붙습니다. 다음 실행부터 적용됩니다.", text);
await row.getByRole("button", { name: "편집", exact: true }).click().catch((error) => note("편집", String(error).slice(0, 200)));
await area.waitFor({ timeout: 10_000 }).catch((error) => note("dialog", String(error).slice(0, 300)));
const title = (await dialog.locator("h2").innerText().catch(() => "")).trim();
const hint = (await dialog.locator("label.field span").first().innerText().catch(() => "")).trim();
check('Y  편집 opens a dialog "추가 프롬프트": an empty text box of at most 4,000 characters, "0 / 4,000자", 저장 disabled, and what the text is for',
  title === "추가 프롬프트" && (await area.inputValue().catch(() => "?")) === "" && (await area.getAttribute("maxlength").catch(() => "")) === "4000" && (await counter()) === "0 / 4,000자" && (await save.isDisabled().catch(() => false)) &&
    hint === "마이닝의 기본 지시 뒤에 붙일 글 (예: 조직의 용어, 프로세스 이름을 짓는 방식). 비우고 저장하면 없어집니다.",
  `${title} · ${await counter()} · ${hint}`);
await area.fill(TEXT).catch((error) => note("fill", String(error).slice(0, 200)));
const typed = await counter();
let savedSaid = true;
await save.click().catch((error) => note("저장", String(error).slice(0, 200)));
await dialog.getByText(SAVED).waitFor({ timeout: 10_000 }).catch(() => { savedSaid = false; });
now = await overview();
await page.screenshot({ path: `${SHOTS}/mining-prompt-saved.png`, fullPage: true });
check(`Y  a text typed there ("${typed}") and 저장 pressed: the dialog says "${SAVED}", GET shows the text, and 저장 is disabled again`, typed === `${TEXT.length} / 4,000자` && savedSaid && now.json?.prompt === TEXT && (await save.isDisabled().catch(() => false)), `GET prompt ${brief(now.json?.prompt, 120)}`);
await closeButton.click().catch((error) => note("닫기", String(error).slice(0, 200)));
await dialog.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
text = await rowText();
check(`Y  the dialog closed, the row reads "${TEXT.length}자"`, (await dialog.count()) === 0 && text.startsWith(`추가 프롬프트 ${TEXT.length}자 편집`), text.slice(0, 60));

// ---------------------------------------------------------------------------------------------------------
// 3. a run with a prompt set
// ---------------------------------------------------------------------------------------------------------
await settled();
const asked = await call(await admin.post("/admin/api/mining/run", {}, PANEL));
const runId = (await runList()).json?.items?.[0]?.id;
await settled();
const run = (await runList()).json?.items?.find((r) => r.id === runId);
note("the run with a prompt set", brief(run, 500));
check("Y  a run with the prompt set ends 완료 with no error (the run process reads the text from mining.db)", asked.status === 200 && run?.status === "completed" && run.error === null, brief({ asked: asked.status, status: run?.status, error: run?.error }));
if (run && run.processed !== 0) console.log(`  (recorded, not judged) this run read ${run.processed} session(s): the stack is older than 30 minutes`);

// ---------------------------------------------------------------------------------------------------------
// 4. after a reload, and cleared
// ---------------------------------------------------------------------------------------------------------
await page.reload();
await row.waitFor({ timeout: 15_000 }).catch((error) => note("page", String(error).slice(0, 300)));
await row.getByRole("button", { name: "편집", exact: true }).click().catch((error) => note("편집", String(error).slice(0, 200)));
await area.waitFor({ timeout: 10_000 }).catch((error) => note("dialog", String(error).slice(0, 300)));
check("Y  after a reload the row still reads the count and 편집 shows the saved text, 저장 disabled", (await rowText()).startsWith(`추가 프롬프트 ${TEXT.length}자 편집`) && (await area.inputValue().catch(() => "")) === TEXT && (await save.isDisabled().catch(() => false)), `${(await rowText()).slice(0, 40)} · ${await counter()}`);
savedSaid = true;
await area.fill("").catch((error) => note("fill", String(error).slice(0, 200)));
await save.click().catch((error) => note("저장", String(error).slice(0, 200)));
await dialog.getByText(SAVED).waitFor({ timeout: 10_000 }).catch(() => { savedSaid = false; });
now = await overview();
await closeButton.click().catch((error) => note("닫기", String(error).slice(0, 200)));
await dialog.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
text = await rowText();
check('Y  the text box emptied and 저장 pressed: saved, GET shows null, and with the dialog closed the row reads "없음" again', savedSaid && now.json?.prompt === null && (await dialog.count()) === 0 && text.startsWith("추가 프롬프트 없음 편집"), `GET prompt ${brief(now.json?.prompt)} · ${text.slice(0, 40)}`);
const csp = await page.evaluate(() => window.__csp).catch(() => ["(page gone)"]);
check("Y  …with no page error, failed call or CSP violation", problems.length === 0 && csp.length === 0, brief({ problems, csp }));
await browser.close();

// ---------------------------------------------------------------------------------------------------------
// 5. the logs
// ---------------------------------------------------------------------------------------------------------
const gatewayAll = dindTry("sh", "-c", `docker logs ${GATEWAY_C} 2>&1`).out;
const promptLines = gatewayAll.split("\n").filter((l) => /mining prompt updated/.test(l));
note("gateway log: mining prompt updated", promptLines.slice(-7).join("\n").slice(0, 1200) || "(none)");
check(`Y  the gateway logged each change at info with a character count ("chars":${TEXT.length}, 4000, 0)`, promptLines.length >= 6 && promptLines.every((l) => /"level":30/.test(l)) && promptLines.some((l) => l.includes(`"chars":${TEXT.length},`)) && promptLines.some((l) => l.includes('"chars":4000,')) && promptLines.some((l) => l.includes('"chars":0,')), `${promptLines.length} line(s)`);
const miningAll = dindTry("sh", "-c", `docker logs ${MINING_C} 2>&1`).out;
check("Y  …and the text itself is in neither the gateway's log nor the mining service's", !gatewayAll.includes("zqx-품의") && !miningAll.includes("zqx-품의") && !gatewayAll.includes("가".repeat(50)), `gateway ${gatewayAll.split("\n").length} line(s), mining ${miningAll.split("\n").length} line(s)`);
check("Y  left as found: no prompt set", (await overview()).json?.prompt === null, brief((await overview()).json?.prompt));

finish();
