#!/usr/bin/env node
// L — pi-gateway 02a023e (2026-11-14): the per-turn tool call limit, 200 in pi's code until now, is a setting of
// pi's admin panel (기본 도구 → "턴당 도구 호출 상한", 1–10000). Looked at here the way a Noah admin reaches it —
// through Noah's /admin proxy against the REAL gateway — and from the other side: what an owner's chat through
// Noah is told when a turn hits it. pi's own tests drive the route in-process and looked at the page with a fake API.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { NOAH, W, check, client, dindTry, fake, finish, loadState, repoRequire, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const anon = client();
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const RUN = Date.now().toString(36);
const DIR = `/workspace/tcl-${RUN}`;
const KOREAN = "응답이 최대 처리 단계에 도달해 중단되었습니다. 질문을 더 작게 나눠 다시 시도해 주세요.";
const brief = (v, n = 300) => JSON.stringify(v).slice(0, n);

const getLimit = async (c = admin) => {
  const res = await c.get("/admin/api/tools");
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, limit: json?.maxToolCallsPerTurn, tools: json?.tools?.length, text };
};
const putLimit = async (value, { c = admin, headers = PANEL } = {}) => {
  const res = await c.put("/admin/api/tool-call-limit", { value }, headers);
  return { status: res.status, text: (await res.text()).slice(0, 300) };
};

/** One owner turn: `n` bash calls (each appends its number to a file in the sandbox), then an answer. */
async function callsTurn(n, label, { conv = randomUUID(), firstText } = {}) {
  const key = `tcl-${RUN}-${conv.slice(0, 8)}`;
  await fake.reset(key);
  const file = `${DIR}/${label}.txt`;
  await fake.enqueue(key, [
    ...Array.from({ length: n }, (_, i) => ({ ...(i === 0 && firstText ? { text: firstText } : {}), toolCalls: [{ name: "bash", arguments: { command: `mkdir -p ${DIR} && echo ${i + 1} >> ${file} && cat ${file} | tr '\\n' ' '` } }] })),
    { text: `끝 (${label})` },
  ]);
  const t = await turn(admin, { avatarId: state.owner.id, conversationId: conv, message: `도구 ${n}번 (${label}) [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const toolResults = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content).trim());
  const done = t.of("done")[0];
  const events = {};
  for (const f of t.frames) events[f.event] = (events[f.event] ?? 0) + 1;
  return { conv, key, file, t, done, events, llmCalls: reqs.length, toolResults, content: String(done?.message?.content ?? "") };
}
const completes = (r, label) => r.t.status === 200 && r.t.of("done").length === 1 && r.t.of("error").length === 0 && r.content.includes(`끝 (${label})`);

// ---------------------------------------------------------------------------------------------------------
// 1. the fresh stack
// ---------------------------------------------------------------------------------------------------------
let now = await getLimit();
check("L  GET /admin/api/tools as a Noah admin → 200 with maxToolCallsPerTurn: 200 (nothing was ever set)", now.status === 200 && now.limit === 200, `${now.status}, maxToolCallsPerTurn ${now.limit}, ${now.tools} tools`);
const before = await callsTurn(4, "before");
check("L  (control) at 200, an owner turn with 4 tool calls completes", completes(before, "before") && before.llmCalls === 5, `LLM calls ${before.llmCalls}; last result ${brief(before.toolResults.at(-1))}`);

// ---------------------------------------------------------------------------------------------------------
// 2. changing it through Noah's /admin proxy
// ---------------------------------------------------------------------------------------------------------
let put = await putLimit(3);
now = await getLimit();
check("L  PUT /admin/api/tool-call-limit {value: 3} → 200, and GET shows 3", put.status === 200 && now.limit === 3, `${put.status} ${put.text}; GET → ${now.limit}`);
for (const [bad, why] of [[0, "below the range"], [10001, "above the range"], [2.5, "not an integer"], ["3", "a string"]]) {
  put = await putLimit(bad);
  check(`L  PUT {value: ${JSON.stringify(bad)}} (${why}) → 400 invalid_tool_call_limit`, put.status === 400 && put.text.includes("invalid_tool_call_limit"), `${put.status} ${put.text}`);
}
now = await getLimit();
check("L  …and the value is still 3", now.limit === 3, `GET → ${now.limit}`);
put = await putLimit(9, { c: member });
const memberGet = await getLimit(member);
check("L  a non-admin member: PUT → 403 and GET → 403", put.status === 403 && memberGet.status === 403, `PUT ${put.status} ${put.text.slice(0, 80)}; GET ${memberGet.status}`);
put = await putLimit(9, { c: anon });
check("L  anonymous PUT → 403", put.status === 403, `${put.status} ${put.text.slice(0, 80)}`);
put = await putLimit(9, { headers: {} });
now = await getLimit();
check("L  an admin's PUT WITHOUT the panel's headers → 403 (csrf), value still 3", put.status === 403 && now.limit === 3, `${put.status} ${put.text.slice(0, 100)}; GET → ${now.limit}`);

// ---------------------------------------------------------------------------------------------------------
// 3. what an owner's chat through Noah is told at the limit (3)
// ---------------------------------------------------------------------------------------------------------
const three = await callsTurn(3, "three");
check("L  at 3, a turn with 3 tool calls completes (the limit is the number of calls allowed)", completes(three, "three") && three.llmCalls === 4, `LLM calls ${three.llmCalls}; last result ${brief(three.toolResults.at(-1))}`);

const four = await callsTurn(4, "four");
writeFileSync(`${W}/evidence/L-stopped-turn-frames.json`, JSON.stringify(four.t.frames, null, 1));
console.log(`  the stopped turn (4 calls, no text): HTTP ${four.t.status}; SSE events ${brief(four.events)}; LLM calls ${four.llmCalls}`);
console.log(`  its done frame: ${brief(four.done, 900)}`);
console.log(`  its error frames: ${brief(four.t.of("error"))}`);
console.log(`  tool results the model had read when it was stopped: ${brief(four.toolResults)}`);
check(
  "L  at 3, a turn in which the model makes a 4th tool call is stopped: Noah's answer is the Korean max-steps message",
  four.t.status === 200 && four.t.of("done").length === 1 && four.content === KOREAN && !four.content.includes("끝 (four)"),
  brief(four.content),
);
check("L  …the model was asked 4 times and never a 5th (no call after the stop)", four.llmCalls === 4, `LLM calls ${four.llmCalls}`);
const stored = await (await admin.get(`/api/messages?conversationId=${four.conv}`)).json();
const storedList = stored.messages ?? stored;
const lastStored = Array.isArray(storedList) ? storedList.at(-1) : null;
console.log(`  the stored assistant message: ${brief({ role: lastStored?.role, content: lastStored?.content, keys: lastStored ? Object.keys(lastStored) : [] }, 700)}`);
check("L  …and that message is what the conversation keeps", lastStored?.role === "assistant" && String(lastStored?.content ?? "") === KOREAN);

const withText = await callsTurn(4, "text", { firstText: "먼저 확인합니다." });
writeFileSync(`${W}/evidence/L-stopped-turn-with-text-frames.json`, JSON.stringify(withText.t.frames, null, 1));
console.log(`  a stopped turn whose model also WROTE something (4 calls): events ${brief(withText.events)}; done content ${brief(withText.content, 300)}`);
console.log(`  (recorded, not judged) with text already written the answer is ${withText.content === KOREAN ? "the Korean message alone" : withText.content.includes(KOREAN) ? "the text plus the Korean message" : "the text alone, with no stop message"}`);

// ---------------------------------------------------------------------------------------------------------
// 4. the panel's page in a real browser, through Noah's /admin (pi's commit looked at it with a fake API)
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
await page.goto(`${NOAH}/admin/#/tools`);
const input = page.locator("#tool-call-limit");
await input.waitFor({ timeout: 15_000 });
await page.waitForFunction(() => document.querySelector("#tool-call-limit")?.value !== "", null, { timeout: 10_000 });
const save = page.locator(".row:has(#tool-call-limit) button");
const shown = await input.inputValue();
const label = await page.locator('label[for="tool-call-limit"]').innerText();
check("L  the 기본 도구 page shows the setting with the value now in force (3), 저장 disabled until it changes", label === "턴당 도구 호출 상한" && shown === "3" && (await save.isDisabled()), `label ${brief(label)}, input ${brief(shown)}`);
await input.fill("0");
const zeroDisabled = await save.isDisabled();
await input.fill("10001");
const bigDisabled = await save.isDisabled();
check("L  …0 and 10001 typed there leave 저장 disabled", zeroDisabled && bigDisabled);
await input.fill("5");
await save.click();
await page.getByText("저장했습니다. 다음 턴부터 적용됩니다.").waitFor({ timeout: 10_000 });
await page.screenshot({ path: `${SHOTS}/tools-tool-call-limit.png`, fullPage: true });
now = await getLimit();
const csp = await page.evaluate(() => window.__csp);
check("L  …5 typed and 저장 pressed: the page says 저장했습니다. 다음 턴부터 적용됩니다., and GET shows 5", now.limit === 5 && (await input.inputValue()) === "5", `GET → ${now.limit}`);
check("L  …with no page error, failed call or CSP violation", problems.length === 0 && csp.length === 0, brief({ problems, csp }));
await browser.close();

// ---------------------------------------------------------------------------------------------------------
// 5. back to 200: it applies from the next turn, in the conversation that was stopped too
// ---------------------------------------------------------------------------------------------------------
put = await putLimit(200);
now = await getLimit();
check("L  PUT {value: 200} → 200 and GET shows 200 again", put.status === 200 && now.limit === 200, `${put.status}; GET → ${now.limit}`);
const again = await callsTurn(4, "again", { conv: four.conv });
check("L  the conversation that was stopped goes on: its next turn with 4 tool calls completes", completes(again, "again"), `LLM calls ${again.llmCalls}; ${brief(again.t.json ?? again.t.of("error"))}`);
const ran = await callsTurn(1, "ran");
const seen = dindTry("sh", "-c", `find ${W}/home/workspaces -path '*tcl-${RUN}/*.txt' | sort | while read -r f; do echo "$(basename "$f"): $(tr '\\n' ' ' < "$f")"; done`);
console.log(`  what each turn's calls left in the owner's workspace:\n${seen.out.split("\n").filter(Boolean).map((l) => "    " + l).join("\n")}`);
const fourFile = /four\.txt: ([\d ]*)/.exec(seen.out)?.[1]?.trim();
console.log(`  (recorded, not judged) in the stopped turn the 4th call ${fourFile === "1 2 3" ? "did NOT run (the file holds 1 2 3)" : `left: ${fourFile}`}`);
void ran;

// ---------------------------------------------------------------------------------------------------------
// 6. Noah's audit log and the gateway's log
// ---------------------------------------------------------------------------------------------------------
const audit = (await (await admin.get("/api/audit")).json()).audit ?? [];
const rows = audit.filter((e) => e.action === "pi_admin_proxy" && e.detail.includes("tool-call-limit"));
console.log(`  audit rows for the setting (${rows.length}):`);
for (const row of rows) console.log(`    ${brief({ action: row.action, detail: row.detail, status: row.status, user: row.username ?? row.userId ?? row.actor ?? undefined })}`);
writeFileSync(`${W}/evidence/L-audit-rows.json`, JSON.stringify(rows, null, 1));
check(
  "L  every PUT that reached pi is an audit row `pi_admin_proxy` whose detail is exactly `PUT /admin/api/tool-call-limit` — never the value",
  rows.length >= 7 && rows.every((e) => e.detail === "PUT /admin/api/tool-call-limit") && !JSON.stringify(rows).includes('"value"'),
  `${rows.length} rows; statuses ${brief(rows.reduce((acc, e) => ((acc[e.status] = (acc[e.status] ?? 0) + 1), acc), {}))}`,
);
const reads = audit.filter((e) => e.action === "pi_admin_proxy" && /^GET \/admin\/api\/tools\b/.test(e.detail));
console.log(`  audit rows for GET /admin/api/tools: ${reads.length} (an unaudited read)`);
const log = dindTry("docker", "logs", "noah-almighty-gateway-1").out;
const lines = log.split("\n").filter((l) => l.includes("tool call limit updated"));
console.log(`  gateway log "tool call limit updated": ${lines.length} line(s); values ${lines.map((l) => /"maxToolCallsPerTurn":(\d+)/.exec(l)?.[1]).join(", ")}`);
check("L  the gateway logs each change with the value (3, 5, 200)", lines.length === 3);
finish();
