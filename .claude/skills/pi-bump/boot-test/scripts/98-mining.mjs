#!/usr/bin/env node
// N — pi's process mining in Noah's stack, as it is since pi-gateway 28ab28e / 47e9047 (2026-11-19): `mining` is
// an always-up service (the gateway image, no secret, the `edge` network only) that waits for a request row in
// `mining-data`, a volume the gateway now mounts WRITABLE; pi's admin panel has a 프로세스 마이닝 page (run now,
// a daily time, the run history, the processes and their edits). pi's commits ran the service as one container
// next to a gateway.db and never opened the page ("확인하지 못한 것: 화면을 띄워 눈으로 보는 것").
// This replaces `98-mining-report.mjs` (pi 9f579dd), whose every line asserted what 28ab28e removed: the compose
// profile that kept `up` from starting mining, `docker compose run mining`, report.md and its route
// `GET /admin/api/mining/report`, the read-only /mining mount, the section on the 대화 기록 page.
// Looked at here:
//   - the container as NOAH's combined stack starts it (hardening, networks, mounts, who owns mining.db);
//   - the routes the way a Noah admin reaches them — through Noah's /admin proxy against the real gateway;
//   - the page in a real browser, 지금 실행 pressed there, and the run the service then does: it reads the
//     gateway's database from a read-only mount and the default model from pi's LLM settings.
// No session in a fresh stack has rested 30 minutes, so the run reads NOTHING and calls no model: what extraction
// and labelling do with a model is NOT seen here (run by hand on a stack older than 30 minutes, the run would
// send the fake LLM sessions it cannot answer and end 중단).
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
let now = await overview();
note("GET /admin/api/mining (Noah admin)", now.text);
// A fresh stack has no run yet; run again alone on the same stack, the earlier runs are there and are counted.
const before = now.json?.runs?.length ?? -1;
check(`N  GET /admin/api/mining as a Noah admin → 200: ${before === 0 ? "no run" : `${before} earlier run(s)`}, no schedule, no process yet`, now.status === 200 && Array.isArray(now.json?.runs) && now.json.dailyAt === null && Array.isArray(now.json.labels) && now.json.labels.length === 0 && Array.isArray(now.json.revisions), now.text);
const asMember = await overview(member);
const asAnon = await overview(anon);
check("N  …a member is refused (403), an anonymous caller gets nothing", asMember.status === 403 && asAnon.status !== 200, `member ${asMember.status}, anonymous ${asAnon.status}`);
let res = await call(await admin.post("/admin/api/mining/run", {}));
check("N  POST /admin/api/mining/run WITHOUT the panel headers → 403, and no run is requested", res.status === 403 && (await overview()).json?.runs?.length === before, `${res.status} ${res.text}`);
res = await call(await member.post("/admin/api/mining/run", {}, PANEL));
check("N  …a member's POST with the panel headers → 403", res.status === 403, `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: "25:00" }, PANEL));
check("N  PUT /admin/api/mining/schedule {dailyAt:\"25:00\"} → 400 invalid_schedule", res.status === 400 && res.json?.error?.code === "invalid_schedule", `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: "03:30" }, PANEL));
now = await overview();
check("N  …{dailyAt:\"03:30\"} → 200 and GET shows it (the gateway can write mining.db)", res.status === 200 && now.json?.dailyAt === "03:30", `${res.status} ${res.text}; GET dailyAt ${brief(now.json?.dailyAt)}`);
res = await call(await admin.put("/admin/api/mining/schedule", { dailyAt: null }, PANEL));
now = await overview();
check("N  …{dailyAt:null} → 200 and the schedule is off again", res.status === 200 && now.json?.dailyAt === null, `${res.status} ${res.text}`);
res = await call(await admin.put("/admin/api/mining/labels/999", { name: "없는 프로세스", criteria: "없는 기준" }, PANEL));
check("N  PUT /admin/api/mining/labels/999 → 404 label_not_found (the edit routes are behind the proxy)", res.status === 404 && res.json?.error?.code === "label_not_found", `${res.status} ${res.text}`);
res = await call(await admin.get("/admin/api/mining/episodes"));
check("N  GET /admin/api/mining/episodes → 200 {items:[], total:0}", res.status === 200 && Array.isArray(res.json?.items) && res.json.items.length === 0 && res.json.total === 0, `${res.status} ${res.text}`);

// ---------------------------------------------------------------------------------------------------------
// 3. the page in a real browser, through Noah's /admin: 지금 실행 pressed there
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
await page.goto(`${NOAH}/admin/#/mining`);
const runButton = page.getByRole("button", { name: "지금 실행" });
let pageOk = true;
try {
  await runButton.waitFor({ timeout: 15_000 });
  if (before === 0) await page.getByText("아직 실행한 적이 없습니다.").waitFor({ timeout: 10_000 });
  else await page.locator("table.table tbody tr").first().waitFor({ timeout: 10_000 });
} catch (error) {
  pageOk = false;
  note("page", String(error).slice(0, 300));
}
const navLabel = await page.getByText("프로세스 마이닝").first().innerText().catch(() => "");
check(`N  the 프로세스 마이닝 page opens: 지금 실행 enabled, ${before === 0 ? '"아직 실행한 적이 없습니다."' : "the earlier runs listed"}, "현재: 자동으로 실행하지 않음"`, pageOk && navLabel === "프로세스 마이닝" && (await runButton.isEnabled()) && (await page.getByText("현재: 자동으로 실행하지 않음").count()) === 1);
await page.screenshot({ path: `${SHOTS}/mining-before.png`, fullPage: true });
const pressedAt = Date.now();
let said = true;
await runButton.click();
await page.getByText("실행을 요청했습니다. mining 서비스가 10초 안에 시작합니다.").waitFor({ timeout: 10_000 }).catch(() => { said = false; });
now = await overview();
const requested = now.json?.runs?.[0];
check("N  지금 실행 pressed: the page says \"실행을 요청했습니다. mining 서비스가 10초 안에 시작합니다.\", and GET shows ONE more run, a manual one", said && now.json?.runs?.length === before + 1 && requested?.trigger === "manual", brief(requested));
// A second request while that one is requested or running. (The service looks every 10 s and a run that reads
// nothing ends within a second, so the first may already be over: then this one is simply accepted — recorded.)
res = await call(await admin.post("/admin/api/mining/run", {}, PANEL));
const firstNow = (await overview()).json?.runs?.find((r) => r.id === requested?.id);
if (res.status === 200) console.log(`  (recorded, not judged) the second POST was accepted — the first run was already ${firstNow?.status}`);
else check("N  a second POST while it is requested or running → 409 mining_busy", res.status === 409 && res.json?.error?.code === "mining_busy", `${res.status} ${res.text}`);

// ---------------------------------------------------------------------------------------------------------
// 4. the run the service does
// ---------------------------------------------------------------------------------------------------------
const FINAL = ["completed", "time_limit", "aborted", "failed"];
let runs = [];
for (let i = 0; i < 45; i++) {
  runs = (await overview()).json?.runs ?? [];
  if (runs.length > 0 && runs.every((r) => FINAL.includes(r.status))) break;
  await sleep(1000);
}
const done = runs.find((r) => r.id === requested?.id);
const took = done?.startedAt ? Date.parse(done.startedAt) - pressedAt : NaN;
note("the run", brief(done, 600));
check("N  the service takes the request the gateway wrote and the run ends 완료 (completed) with no error", done?.status === "completed" && done.error === null, brief(done));
check("N  …started within 15 s of the press", Number.isFinite(took) && took < 15_000, `${took} ms after the press`);
check("N  …it read the model from pi's LLM settings out of the read-only gateway.db (fake-model)", done?.model === "fake-model", brief(done?.model));
check("N  …and read no session (none has rested 30 minutes): 0 read, 0 failed, 0 left, 0 tasks, 0 changes", done?.processed === 0 && done.failed === 0 && done.remaining === 0 && done.episodes === 0 && done.changes === 0, brief({ processed: done?.processed, failed: done?.failed, remaining: done?.remaining, episodes: done?.episodes, changes: done?.changes }));
await page.reload();
const row = page.locator("table.table tbody tr").first();
let rowText = "";
try {
  await page.getByText("완료").first().waitFor({ timeout: 15_000 });
  rowText = (await row.innerText()).replace(/\s+/g, " ");
} catch (error) {
  note("page after the run", String(error).slice(0, 300));
}
await page.screenshot({ path: `${SHOTS}/mining-after-run.png`, fullPage: true });
check("N  the page's 실행 이력 shows that run: 수동, 완료, fake-model", /수동/.test(rowText) && /완료/.test(rowText) && /fake-model/.test(rowText), rowText.slice(0, 200));
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
