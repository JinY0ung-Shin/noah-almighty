#!/usr/bin/env node
// Z — "이름 다시 짓기", the process-mining run that only renames existing processes (pi-gateway f9df928, 2026-11-20):
// `POST /admin/api/mining/rename` requests a run whose trigger is `rename`; the 프로세스 section has a button for it
// (disabled while no process is there to rename or a run is busy); the run history names the trigger "이름 다시 짓기".
// pi's tests cover the rename pass on a scripted model; the route, the button and the run process were not looked at on
// a real gateway. Looked at here through Noah's /admin proxy as a Noah admin and in a real browser:
//   - who may call it (panel headers, Noah admin), a second request while one is requested → 409 mining_busy;
//   - the run: trigger `rename`, ends 완료 with nothing read (a fresh stack has no process and no session);
//   - the page: the button is there and DISABLED (no process), the history row reads "이름 다시 짓기";
//   - the gateway's log: "mining run requested" with trigger rename.
// NOT seen: a process actually renamed (a fresh stack has none; creating one needs a model that finds a process) —
// rests on pi's mining.test.ts. Leaves nothing behind. Run alone it needs a stack with no run active.
import { mkdirSync } from "node:fs";
import { NOAH, W, check, client, dindTry, finish, loadState, repoRequire } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const brief = (v, n = 300) => JSON.stringify(v).slice(0, n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (res) => {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300).replace(/\s+/g, " ") };
};
const overview = async () => call(await admin.get("/admin/api/mining"));
const runList = async () => call(await admin.get("/admin/api/mining/runs"));
const settled = async () => {
  let o = await overview();
  for (let i = 0; i < 45 && o.json?.active; i++) { await sleep(1000); o = await overview(); }
  return o;
};

await settled();
let res = await call(await admin.post("/admin/api/mining/rename", {}, {}));
check("Z  POST /admin/api/mining/rename WITHOUT the panel headers → 403", res.status === 403, `${res.status} ${res.text}`);
res = await call(await member.post("/admin/api/mining/rename", {}, PANEL));
check("Z  …a member's POST with the panel headers → 403", res.status === 403, `${res.status} ${res.text}`);
const before = (await runList()).json?.items?.length ?? 0;
res = await call(await admin.post("/admin/api/mining/rename", {}, PANEL));
const id = res.json?.id;
check("Z  …a Noah admin with the panel headers → 200 {id}", res.status === 200 && Number.isInteger(id), `${res.status} ${res.text}`);
const again = await call(await admin.post("/admin/api/mining/rename", {}, PANEL));
check("Z  …a second request while it is requested → 409 mining_busy", again.status === 409 && again.json?.error?.code === "mining_busy", `${again.status} ${again.text}`);
const manual = await call(await admin.post("/admin/api/mining/run", {}, PANEL));
check("Z  …and 지금 실행 is refused the same way (one run at a time)", manual.status === 409 && manual.json?.error?.code === "mining_busy", `${manual.status} ${manual.text}`);
await settled();
const list = (await runList()).json?.items ?? [];
const run = list.find((r) => r.id === id);
console.log(`  the run: ${brief(run, 500)}`);
check("Z  the run is in the history with trigger `rename`, ends completed with no error and read nothing", list.length === before + 1 && run?.trigger === "rename" && run.status === "completed" && run.error === null && run.processed === 0, brief({ trigger: run?.trigger, status: run?.status, error: run?.error, processed: run?.processed }));

const { chromium } = repoRequire("playwright");
const SHOTS = `${W}/evidence/admin-ui`;
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-gpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" });
const [cookieName, ...rest] = state.owner.cookie.split(";")[0].split("=");
await context.addCookies([{ name: cookieName, value: rest.join("="), url: NOAH }]);
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("response", (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${new URL(r.url()).pathname}`));
await page.goto(`${NOAH}/admin/#/mining`);
const button = page.getByRole("button", { name: "이름 다시 짓기", exact: true });
await button.waitFor({ timeout: 15_000 }).catch((e) => console.log(`  button: ${String(e).slice(0, 200)}`));
const disabled = await button.isDisabled().catch(() => null);
check("Z  the 프로세스 section has a 이름 다시 짓기 button, DISABLED while there is no process to rename", (await button.count()) === 1 && disabled === true, `count ${await button.count()} disabled ${disabled}`);
const cell = await page.locator("table tbody td", { hasText: "이름 다시 짓기" }).count();
await page.screenshot({ path: `${SHOTS}/mining-rename.png`, fullPage: true });
check('Z  the run history row names the trigger "이름 다시 짓기"', cell >= 1, `${cell} cell(s)`);
check("Z  …with no page error or failed call", problems.length === 0, brief(problems));
await browser.close();

const log = dindTry("sh", "-c", "docker logs noah-almighty-gateway-1 2>&1").out.split("\n").filter((l) => /mining run requested/.test(l) && /"trigger":"rename"/.test(l));
check('Z  the gateway logged "mining run requested" with "trigger":"rename"', log.length >= 1 && log.every((l) => /"level":30/.test(l)), `${log.length} line(s)`);
finish();
