#!/usr/bin/env node
// N — pi's process mining in Noah's stack (pi-gateway 417ebc6 / 8427ed1 / 9f579dd, 2026-11-19). pi added a
// `mining` compose service (profile `mining`: a cron runs it once a day, `up` never starts it) that summarises
// stored sessions with the default LLM and writes a report, plus a "프로세스 마이닝" section on the admin panel's
// 대화 기록 page that shows the last report. pi's commits ran typecheck, vitest and the admin build; they say the
// page was never looked at in a browser and mining was never run against a real LLM server.
// This looks at what only a stack shows, through Noah:
//   - `up` did not start mining, and the gateway holds the report volume read-only;
//   - Noah's /admin proxy serves the new route to a Noah admin only, `{"report":null}` before any run;
//   - ONE run of `docker compose run --rm -T mining` inside Noah's project works (it reads the gateway's database
//     read-only next to the running gateway), and its report is then what the route and the page show;
//   - the page in a real browser, through the proxy: the section, the 보고서 보기 window, no error.
// The sessions of this stack are minutes old and mining reads only sessions idle for 30 minutes, so it reads
// none here: what it SENDS to an LLM, the labels and the report of real work are NOT seen (pi's tests).
// Once per stack: after a run the route no longer answers null (to run it again by hand, empty the volume
// first: `docker exec noahcompose-dind sh -c 'rm -f /var/lib/docker/volumes/noah-almighty_mining-data/_data/*'`).
import { execFileSync } from "node:child_process";
import { check, client, dind, dindTry, finish, loadState, NOAH, repoRequire, W } from "./e2e-common.mjs";

const { chromium } = repoRequire("playwright");
const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const anonymous = client();
const GATEWAY_C = "noah-almighty-gateway-1";
const VOLUME = "/var/lib/docker/volumes/noah-almighty_mining-data/_data";
const note = (label, text) => console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);
const report = async (c) => {
  const res = await c.get("/admin/api/mining/report");
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: judged by the status */
  }
  return { status: res.status, body, text };
};
const miningContainers = () => dind("docker", "ps", "-a", "--format", "{{.Names}} {{.Status}}").split("\n").filter((l) => /mining/.test(l));

// ---------------------------------------------------------------------------------------------- before any run
check("N  `up` started no mining container (the service has a profile)", miningContainers().length === 0, miningContainers().join("; "));
const mounts = dind("docker", "inspect", "-f", "{{range .Mounts}}{{.Destination}}={{.RW}} {{end}}", GATEWAY_C).trim();
note("gateway mounts (destination=writable)", mounts);
check("N  the gateway holds the report volume at /mining READ-ONLY", /(^| )\/mining=false( |$)/.test(mounts), mounts);
let got = await report(admin);
note("GET /admin/api/mining/report (admin, before a run)", `${got.status} ${got.text.slice(0, 200)}`);
check("N  before any run the route answers 200 {\"report\":null} to a Noah admin", got.status === 200 && got.body && got.body.report === null, `${got.status} ${got.text.slice(0, 120)}`);
const denied = await report(member);
check("N  a non-admin member → 403", denied.status === 403 && !denied.text.includes("report"), `${denied.status} ${denied.text.slice(0, 90)}`);
const anon = await report(anonymous);
check("N  anonymous → 403", anon.status === 403, `${anon.status} ${anon.text.slice(0, 90)}`);

// ---------------------------------------------------------------------------------------------- one run
let run = { status: 0, stdout: "", stderr: "" };
const started = Date.now();
try {
  run.stdout = execFileSync("docker", ["exec", "-w", `${W}/noah-almighty`, "noahcompose-dind", "docker", "compose", "run", "--rm", "-T", "mining"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  run = { status: err.status ?? -1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
note(`docker compose run --rm -T mining (exit ${run.status}, ${seconds}s) — stdout, the report`, run.stdout.trim() || "(empty)");
if (run.stderr.trim()) note("its stderr", run.stderr.trim().split("\n").slice(-12).join("\n"));
check("N  one mining run inside Noah's project exits 0 and prints a report", run.status === 0 && run.stdout.trim().length > 0, `exit ${run.status}`);
check("N  the run left no container behind (--rm)", miningContainers().length === 0, miningContainers().join("; "));
const files = dindTry("sh", "-c", `ls -ln ${VOLUME}`);
note("the report volume", files.out.trim());
check("N  the volume holds report.md and mining.db, owned by uid 10001 and readable by the owner only", /^-rw-------\s+1\s+10001\s+10001\s+\d+ .* mining\.db$/m.test(files.out) && /^-rw-------\s+1\s+10001\s+10001\s+\d+ .* report\.md$/m.test(files.out));

// ---------------------------------------------------------------------------------------------- after the run
got = await report(admin);
check("N  the route now answers the report mining printed, byte for byte", got.status === 200 && typeof got.body?.report === "string" && got.body.report === run.stdout, `${got.status}, ${got.body?.report?.length ?? "no"} chars vs ${run.stdout.length}`);
check("N  …still 403 for a member", (await report(member)).status === 403);
const gatewayLog = dindTry("docker", "logs", "--since", "3m", GATEWAY_C);
check("N  the gateway logged no error while mining read its database", !/"level":(50|60)/.test(gatewayLog.out));

// ---------------------------------------------------------------------------------------------- the page, in a real browser
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
await page.locator(".page-head h1").waitFor({ timeout: 15_000 });
await page.waitForTimeout(700);
problems.length = 0;
const section = page.getByText("프로세스 마이닝", { exact: true }).first();
const sectionSeen = await section.isVisible().catch(() => false);
check("N  the 대화 기록 page shows the 프로세스 마이닝 section (through Noah's /admin proxy)", sectionSeen);
let shown = "";
if (sectionSeen) {
  await page.getByRole("button", { name: "보고서 보기" }).click();
  const body = page.locator(".md").last();
  await body.waitFor({ timeout: 10_000 }).catch(() => {});
  shown = (await body.innerText().catch(() => "")).trim();
  await page.screenshot({ path: `${W}/evidence/mining-report.png` });
}
note("the 보고서 보기 window reads", shown.slice(0, 500) || "(nothing)");
// The window draws the Markdown: compare on the words, not the markup.
const words = (text) => text.replace(/[#*_`>|-]/g, " ").split(/\s+/).filter(Boolean);
const reportWords = words(run.stdout).slice(0, 12);
check("N  보고서 보기 opens the report mining wrote", shown.length > 0 && reportWords.length > 0 && reportWords.every((w) => shown.includes(w)), `first words: ${reportWords.join(" ")}`);
const csp = await page.evaluate(() => window.__csp);
check("N  no page error, failed request or CSP violation on the way", problems.length === 0 && csp.length === 0, [...problems, ...csp].join(" | "));
await browser.close();

finish();
