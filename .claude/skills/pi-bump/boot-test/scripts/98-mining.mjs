#!/usr/bin/env node
// N — pi's process mining in Noah's stack, as it is since pi-gateway 28ab28e / 47e9047 (2026-11-19): `mining` is
// an always-up service (the gateway image, no secret, the `edge` network only) that waits for a request row in
// `mining-data`, a volume the gateway now mounts WRITABLE; pi's admin panel has a 프로세스 마이닝 page (run now,
// a daily time, the run history, the processes and their edits).
// Since 95b0b57 / 4421482 (2026-11-20) a process no longer needs two users' tasks and a run that finds none samples
// again (three times a run); of that, only the page's sentence for an empty stack is seen here.
// Since 7000e9c / 776f575 (2026-11-20) a run reports its progress and can be stopped, an admin sets how many LLM
// calls a run makes at once, and the overview (`GET /admin/api/mining`) carries `active` / `last` / `next` /
// `concurrency` instead of the run and revision lists — those are pages of their own (`/mining/runs`,
// `/mining/revisions`). pi's commits looked at the page with FAKE API answers only ("확인하지 못한 것: 실제
// gateway와 실제 모델로 돌린 화면").
// Looked at here:
//   - the container as NOAH's combined stack starts it (hardening, networks, mounts, who owns mining.db);
//   - the routes the way a Noah admin reaches them — through Noah's /admin proxy against the real gateway;
//   - the page in a real browser: the concurrency saved there, 지금 실행 pressed and the run the service then
//     does (it reads the gateway's database from a read-only mount and the default model from pi's LLM
//     settings), and 중지 pressed on a request the service has not taken yet.
// No session in a fresh stack has rested 30 minutes, so the run reads NOTHING and calls no model: what extraction
// and labelling do with a model, a run's progress (stage, n / m, "지금 LLM에 보낸 것"), 중지 on a RUNNING run and
// more than one call at once are NOT seen here (run by hand on a stack older than 30 minutes, the run would send
// the fake LLM sessions it cannot answer and end 중단).
import { mkdirSync } from "node:fs";
import { NOAH, W, check, client, dind, dindTry, finish, loadState, repoRequire } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const anon = client();
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const MINING_C = "noah-almighty-mining-1";
const GATEWAY_C = "noah-almighty-gateway-1";
const brief = (v, n = 300) => JSON.stringify(v).slice(0, n);
const note = (label, text) => console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);
const inspect = (name, format) => dind("docker", "inspect", "-f", format, name).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (res) => {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300).replace(/\s+/g, " ") };
};
const overview = async (c = admin) => call(await c.get("/admin/api/mining"));

// ---------------------------------------------------------------------------------------------------------
// 1. the container in Noah's stack
// ---------------------------------------------------------------------------------------------------------
const shape = inspect(MINING_C, "{{.State.Status}} restarts={{.RestartCount}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} ports={{.HostConfig.PortBindings}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}");
note("mining container", shape);
check("N  the mining service is running (never restarted) as uid 10001, read-only rootfs, no capability, no published port, no healthcheck", /^running restarts=0 user=10001:10001 readonly=true capdrop=\[ALL\] ports=map\[\] health=none$/.test(shape), shape);
const nets = inspect(MINING_C, "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}").split(" ").filter(Boolean).sort();
check("N  …on pi's edge network ONLY (not control, not noah-mcp, not noah-memory)", nets.length === 1 && nets[0].endsWith("_edge"), nets.join(", "));
const mounts = (name) => inspect(name, "{{range .Mounts}}{{.Destination}}={{.RW}} {{end}}").split(" ").filter(Boolean).sort();
const miningMounts = mounts(MINING_C);
const gatewayMounts = mounts(GATEWAY_C);
note("mounts (destination=writable)", `mining:  ${miningMounts.join(" ")}\ngateway: ${gatewayMounts.join(" ")}`);
check("N  …the gateway's data is mounted READ-ONLY in it, mining-data writable", miningMounts.includes("/data=false") && miningMounts.includes("/mining=true"), miningMounts.join(" "));
check("N  the gateway mounts mining-data writable too (it writes the run request)", gatewayMounts.includes("/mining=true"), gatewayMounts.join(" "));
// Names only — never a value.
const envNames = inspect(MINING_C, "{{range .Config.Env}}{{println .}}{{end}}").split("\n").map((l) => l.split("=")[0]).filter(Boolean).sort();
const secretFiles = dindTry("docker", "exec", MINING_C, "sh", "-c", "ls /run/secrets 2>/dev/null | wc -l").out.trim();
note("env names in the mining container", envNames.join(" "));
check("N  …and holds no secret: no file under /run/secrets, no key/secret/token/password env name", secretFiles === "0" && !envNames.some((n) => /KEY|SECRET|TOKEN|PASSWORD/i.test(n)), `secret files ${secretFiles}`);
const dbFile = dindTry("docker", "exec", MINING_C, "stat", "-c", "%u %a", "/mining/mining.db").out.trim();
check("N  mining.db belongs to uid 10001, owner-only (600)", dbFile === "10001 600", dbFile);

// ---------------------------------------------------------------------------------------------------------
// 2. the routes through Noah's /admin proxy
// ---------------------------------------------------------------------------------------------------------
const runList = async (query = "") => call(await admin.get(`/admin/api/mining/runs${query}`));
const FINAL = ["completed", "time_limit", "aborted", "stopped", "failed"];
/** Wait until no run is requested or running; the overview then. */
const settled = async () => {
  let o = await overview();
  for (let i = 0; i < 45 && o.json?.active; i++) {
    await sleep(1000);
    o = await overview();
  }
  return o;
};
let now = await overview();
note("GET /admin/api/mining (Noah admin)", now.text);
let list = await runList();
// A fresh stack has no run yet; run again alone on the same stack, the earlier runs are there and are counted.
const before = list.json?.total ?? -1;
check(
  `N  GET /admin/api/mining as a Noah admin → 200: nothing requested or running (active null), ${before === 0 ? "nothing finished (last null)" : `${before} earlier run(s), last finished`}, nothing to read (next 0 sessions / 0 tasks), concurrency 1, no schedule, no process — and no runs/revisions list in it (7000e9c)`,
  now.status === 200 && now.json?.active === null && (before === 0 ? now.json.last === null : FINAL.includes(now.json.last?.status)) && now.json.next?.sessions === 0 && now.json.next.episodes === 0 &&
    now.json.concurrency === 1 && now.json.dailyAt === null && Array.isArray(now.json.labels) && now.json.labels.length === 0 && !("runs" in now.json) && !("revisions" in now.json),
  now.text,
);
const revisions = await call(await admin.get("/admin/api/mining/revisions"));
check("N  the lists are pages now: GET …/mining/runs → {items, total, pageSize: 10}, …/mining/revisions → {items: [], total: 0, pageSize: 10}", list.status === 200 && Array.isArray(list.json?.items) && list.json.items.length === Math.min(before, 10) && list.json.pageSize === 10 &&
  revisions.status === 200 && Array.isArray(revisions.json?.items) && revisions.json.items.length === 0 && revisions.json.total === 0 && revisions.json.pageSize === 10, `runs ${list.text} · revisions ${revisions.text}`);
const asMember = await overview(member);
const asAnon = await overview(anon);
const listAsMember = await call(await member.get("/admin/api/mining/runs"));
check("N  …a member is refused (403) on the overview and on a list, an anonymous caller gets nothing", asMember.status === 403 && listAsMember.status === 403 && asAnon.status !== 200, `member ${asMember.status}/${listAsMember.status}, anonymous ${asAnon.status}`);
let res = await call(await admin.post("/admin/api/mining/run", {}));
check("N  POST /admin/api/mining/run WITHOUT the panel headers → 403, and no run is requested", res.status === 403 && (await runList()).json?.total === before && (await overview()).json?.active === null, `${res.status} ${res.text}`);
res = await call(await member.post("/admin/api/mining/run", {}, PANEL));
check("N  …a member's POST with the panel headers → 403", res.status === 403, `${res.status} ${res.text}`);
res = await call(await admin.post("/admin/api/mining/run/stop", {}, PANEL));
check("N  POST /admin/api/mining/run/stop with nothing requested or running → 409 mining_idle", res.status === 409 && res.json?.error?.code === "mining_idle", `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/concurrency", { value: 17 }, PANEL));
check("N  PUT /admin/api/mining/concurrency {value: 17} → 400 invalid_concurrency", res.status === 400 && res.json?.error?.code === "invalid_concurrency", `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/concurrency", { value: 4 }));
const unchanged = (await overview()).json?.concurrency;
check("N  …{value: 4} WITHOUT the panel headers → 403, still 1", res.status === 403 && unchanged === 1, `${res.status} ${res.text}; GET concurrency ${unchanged}`);
res = await call(await admin.put("/admin/api/mining/concurrency", { value: 4 }, PANEL));
now = await overview();
check("N  …{value: 4} with them → 200 {value: 4} and GET shows 4 (the gateway can write mining.db)", res.status === 200 && res.json?.value === 4 && now.json?.concurrency === 4, `${res.status} ${res.text}; GET concurrency ${brief(now.json?.concurrency)}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: "25:00" }, PANEL));
check("N  PUT /admin/api/mining/schedule {dailyAt:\"25:00\"} → 400 invalid_schedule", res.status === 400 && res.json?.error?.code === "invalid_schedule", `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: "03:30" }, PANEL));
now = await overview();
check("N  …{dailyAt:\"03:30\"} → 200 and GET shows it", res.status === 200 && now.json?.dailyAt === "03:30", `${res.status} ${res.text}; GET dailyAt ${brief(now.json?.dailyAt)}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: null }, PANEL));
now = await overview();
check("N  …{dailyAt:null} → 200 and the schedule is off again", res.status === 200 && now.json?.dailyAt === null, `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/labels/999", { name: "없는 프로세스", criteria: "없는 기준" }, PANEL));
check("N  PUT /admin/api/mining/labels/999 → 404 label_not_found (the edit routes are behind the proxy)", res.status === 404 && res.json?.error?.code === "label_not_found", `${res.status} ${res.text}`);
res = await call(await admin.get("/admin/api/mining/episodes"));
check("N  GET /admin/api/mining/episodes → 200 {items:[], total:0, pageSize: 20}", res.status === 200 && Array.isArray(res.json?.items) && res.json.items.length === 0 && res.json.total === 0 && res.json.pageSize === 20, `${res.status} ${res.text}`);

// ---------------------------------------------------------------------------------------------------------
// 3. the page in a real browser, through Noah's /admin: the concurrency saved and 지금 실행 pressed there
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
const dialogs = [];
page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
await page.goto(`${NOAH}/admin/#/mining`);
const runButton = page.getByRole("button", { name: "지금 실행" });
// The 실행 이력 table is the one with a 계기 column (the page has a table per section).
const runRows = page.locator("table.table").filter({ has: page.getByRole("columnheader", { name: "계기" }) }).locator("tbody tr");
let pageOk = true;
try {
  await runButton.waitFor({ timeout: 15_000 });
  if (before === 0) await page.getByText("아직 실행한 적이 없습니다.").waitFor({ timeout: 10_000 });
  else await runRows.first().waitFor({ timeout: 10_000 });
} catch (error) {
  pageOk = false;
  note("page", String(error).slice(0, 300));
}
const navLabel = await page.getByText("프로세스 마이닝").first().innerText().catch(() => "");
const parallel = page.locator("#mining-concurrency");
check(
  `N  the 프로세스 마이닝 page opens: 지금 실행 enabled, ${before === 0 ? '"아직 실행한 적이 없습니다."' : "the earlier runs listed"}, "읽을 새 세션은 없습니다 (…)" and no word of sampling (fewer than 20 unlabelled tasks), "지금은 자동으로 실행하지 않습니다", LLM을 동시에 4`,
  pageOk && navLabel === "프로세스 마이닝" && (await runButton.isEnabled()) && (await page.getByText("읽을 새 세션은 없습니다 (마지막 활동 뒤 30분 넘게 쉰 세션만 읽습니다).").count()) === 1 && (await page.getByText("무작위로 60건씩 3번").count()) === 0 &&
    (await page.getByText("지금은 자동으로 실행하지 않습니다").count()) === 1 && (await parallel.inputValue().catch(() => "")) === "4",
  `LLM을 동시에 ${await parallel.inputValue().catch(() => "(no input)")}`,
);
await page.screenshot({ path: `${SHOTS}/mining-before.png`, fullPage: true });
// The concurrency goes back to 1 on the page (its own 저장, next to the input).
let savedSaid = true;
await parallel.fill("1");
await parallel.locator("xpath=..").getByRole("button", { name: "저장" }).click();
await page.getByText("저장했습니다. 다음 실행부터 적용됩니다.").waitFor({ timeout: 10_000 }).catch(() => { savedSaid = false; });
now = await overview();
check("N  1 typed and its 저장 pressed: the page says \"저장했습니다. 다음 실행부터 적용됩니다.\", and GET shows 1", savedSaid && now.json?.concurrency === 1, `GET concurrency ${brief(now.json?.concurrency)}`);

const pressedAt = Date.now();
let waiting = true;
await runButton.click();
// 7000e9c: no notice any more — the run section itself shows the request waiting for the service.
await page.getByText("mining 서비스가 10초 안에 시작합니다").waitFor({ timeout: 5_000 }).catch(() => { waiting = false; });
const waitingHead = waiting ? (await page.locator(".run-live-head").first().innerText().catch(() => "")).replace(/\s+/g, " ") : "";
now = await overview();
list = await runList();
const requested = list.json?.items?.[0];
if (waiting) {
  check("N  지금 실행 pressed: the page shows \"시작 대기 … 요청 · mining 서비스가 10초 안에 시작합니다\" with a 중지 button, and the runs list has ONE more run, a manual one", /^시작 대기 .*요청 · mining 서비스가 10초 안에 시작합니다 중지$/.test(waitingHead) && list.json?.total === before + 1 && requested?.trigger === "manual", `${waitingHead} · ${brief(requested)}`);
  await page.screenshot({ path: `${SHOTS}/mining-requested.png`, fullPage: true });
} else {
  // The service looks every 10 s: it took the request before the page drew it.
  console.log(`  (recorded, not judged) the page never showed 시작 대기 — the run was already ${requested?.status}`);
  check("N  지금 실행 pressed: the runs list has ONE more run, a manual one", list.json?.total === before + 1 && requested?.trigger === "manual", brief(requested));
}
// A second request while that one is requested or running. (A run that reads nothing ends within a second, so
// the first may already be over: then this one is simply accepted — recorded.)
res = await call(await admin.post("/admin/api/mining/run", {}, PANEL));
if (res.status === 200) console.log("  (recorded, not judged) the second POST was accepted — the first run was already over");
else check("N  a second POST while it is requested or running → 409 mining_busy", res.status === 409 && res.json?.error?.code === "mining_busy", `${res.status} ${res.text}`);

// ---------------------------------------------------------------------------------------------------------
// 4. the run the service does
// ---------------------------------------------------------------------------------------------------------
now = await settled();
const done = (await runList()).json?.items?.find((r) => r.id === requested?.id);
const took = done?.startedAt ? Date.parse(done.startedAt) - pressedAt : NaN;
note("the run", brief(done, 700));
check("N  the service takes the request the gateway wrote and the run ends 완료 (completed) with no error", done?.status === "completed" && done.error === null, brief(done));
check("N  …started within 15 s of the press", Number.isFinite(took) && took < 15_000, `${took} ms after the press`);
check("N  …it read the model from pi's LLM settings out of the read-only gateway.db (fake-model)", done?.model === "fake-model", brief(done?.model));
check("N  …and read no session (none has rested 30 minutes): 0 read, 0 failed, 0 left, 0 tasks, 0 changes, nothing left in working, no stop asked", done?.processed === 0 && done.failed === 0 && done.remaining === 0 && done.episodes === 0 && done.changes === 0 && Array.isArray(done.working) && done.working.length === 0 && done.stopRequested === false,
  brief({ processed: done?.processed, failed: done?.failed, remaining: done?.remaining, episodes: done?.episodes, changes: done?.changes, working: done?.working, stopRequested: done?.stopRequested, stage: done?.stage }));
check("N  the overview has it as `last` and nothing active", now.json?.active === null && now.json.last?.id === done?.id && now.json.last.status === "completed", brief({ active: now.json?.active, last: now.json?.last?.id }));
await page.reload();
let rowText = "";
try {
  await runRows.first().getByText("완료").waitFor({ timeout: 15_000 });
  rowText = (await runRows.first().innerText()).replace(/\s+/g, " ");
} catch (error) {
  note("page after the run", String(error).slice(0, 300));
}
const lastStat = (await page.locator(".stats").first().innerText().catch(() => "")).replace(/\s+/g, " ");
await page.screenshot({ path: `${SHOTS}/mining-after-run.png`, fullPage: true });
check("N  the page's 실행 이력 shows that run first — 수동, 완료, fake-model — and the numbers on top say 마지막 실행 완료, 자동 실행 꺼짐", /수동/.test(rowText) && /완료/.test(rowText) && /fake-model/.test(rowText) && /마지막 실행 완료/.test(lastStat) && /자동 실행 꺼짐/.test(lastStat), `${rowText.slice(0, 160)} · ${lastStat.slice(0, 200)}`);

// 중지 (7000e9c), on the page: a request the service has not taken yet is closed at once. The service looks every
// 10 s after it last looked or finished a run — press just after one of its looks, so the request is still waiting.
const lastFinished = (await runList()).json?.items?.[0]?.finishedAt;
const phase = lastFinished ? (Date.now() - Date.parse(lastFinished)) % 10_000 : 0;
await sleep(phase > 1_000 && phase < 4_000 ? 0 : (11_500 - phase) % 10_000);
await runButton.click();
let stopSeen = true;
const stopButton = page.getByRole("button", { name: "중지", exact: true });
await stopButton.waitFor({ timeout: 5_000 }).catch(() => { stopSeen = false; });
if (stopSeen) await stopButton.click().catch(() => { stopSeen = false; });
now = await settled();
list = await runList();
const stopped = list.json?.items?.[0];
note("the stopped run", brief(stopped, 500));
if (stopSeen && stopped?.status === "stopped") {
  await runRows.first().getByText("중지함").waitFor({ timeout: 10_000 }).catch(() => {});
  const stoppedRow = (await runRows.first().innerText().catch(() => "")).replace(/\s+/g, " ");
  await page.screenshot({ path: `${SHOTS}/mining-stopped.png`, fullPage: true });
  check("N  지금 실행, then 중지 pressed while it waits: the page asks \"실행 요청을 취소할까요?\", the run ends 중지함 (stopped) without ever starting, and 지금 실행 is back",
    dialogs.at(-1) === "실행 요청을 취소할까요?" && stopped.id !== done?.id && stopped.startedAt === null && stopped.finishedAt !== null && list.json.total === before + (res.status === 200 ? 3 : 2) && /수동/.test(stoppedRow) && /중지함/.test(stoppedRow) && (await runButton.isEnabled()),
    `dialog ${brief(dialogs.at(-1))} · ${stoppedRow.slice(0, 120)} · total ${list.json?.total}`);
} else {
  // The service took the request before 중지 could be pressed (it looks every 10 s).
  console.log(`  (recorded, not judged) 중지 was not pressed on a waiting request — 중지 button seen: ${stopSeen}, the run ended ${stopped?.status}`);
}
const csp = await page.evaluate(() => window.__csp);
check("N  …with no page error, failed call or CSP violation", problems.length === 0 && csp.length === 0, brief({ problems, csp }));
await browser.close();

// ---------------------------------------------------------------------------------------------------------
// 5. logs
// ---------------------------------------------------------------------------------------------------------
// The mining service writes its log to stderr (the gateway to stdout): read both streams.
const log = dindTry("sh", "-c", `docker logs ${MINING_C} 2>&1`).out;
note("mining service log", log.trim().split("\n").slice(-8).join("\n").slice(0, 1500));
const runLines = log.split("\n").filter((l) => l.includes(`"run":${requested?.id},`) || l.includes('"msg":"mining finished"'));
check("N  the mining log has this run's start and an end, and no error-level line", runLines.some((l) => l.includes('"msg":"mining run started"')) && runLines.some((l) => l.includes('"msg":"mining finished"')) && !/"level":(50|60)/.test(log), `${log.trim().split("\n").length} line(s)`);
const gatewayLog = dindTry("sh", "-c", `docker logs ${GATEWAY_C} 2>&1`).out.split("\n").filter((l) => /mining/.test(l));
note("gateway log lines about mining", gatewayLog.join("\n").slice(0, 1200) || "(none)");
check("N  the gateway logged the request and the schedule changes, nothing at warn or above about mining", gatewayLog.some((l) => l.includes("mining run requested")) && gatewayLog.some((l) => l.includes("mining schedule updated")) && !gatewayLog.some((l) => /"level":(40|50|60)/.test(l)), `${gatewayLog.length} line(s)`);

finish();
