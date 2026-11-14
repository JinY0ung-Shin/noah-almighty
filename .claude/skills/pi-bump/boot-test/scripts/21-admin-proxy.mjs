#!/usr/bin/env node
// A: the /admin proxy.  B(1): pi's new System One admin routes through that proxy.
import { NOAH, check, client, finish, loadState } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const anon = client();
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const show = async (res) => `${res.status} ${(await res.text()).slice(0, 300).replace(/\s+/g, " ")}`;

// ---- A: session / anonymous / UI ----
let res = await admin.get("/admin/api/session");
let text = await res.text();
check("A  GET /admin/api/session as a Noah admin → 200 {authenticated:true}", res.status === 200 && JSON.parse(text).authenticated === true, `${res.status} ${text}`);
res = await anon.get("/admin/api/session");
text = await res.text();
check("A  anonymous GET /admin/api/session → 403 noah_session_required", res.status === 403 && text.includes("noah_session_required"), `${res.status} ${text.slice(0, 200)}`);
res = await member.get("/admin/api/session");
text = await res.text();
check("A  (extra) approved NON-admin member → refused (not 200)", res.status !== 200, `${res.status} ${text.slice(0, 200)}`);
res = await admin.get("/admin/");
text = await res.text();
const csp = res.headers.get("content-security-policy") ?? "";
const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1];
check("A  GET /admin/ serves pi's UI (html) with a CSP", res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html") && csp.length > 0, `${res.status}, title ${JSON.stringify(title)}, ${text.length} bytes, CSP: ${csp.slice(0, 160)}`);
console.log("     pi UI mentions System One:", /system\s*one/i.test(text));
res = await anon.get("/admin/");
check("A  (extra) anonymous GET /admin/ is not served the UI", res.status !== 200 || !(await res.clone().text()).includes("<title>" + title), `${res.status} ${res.headers.get("location") ?? ""}`);

// ---- B(1): System One ----
res = await admin.get("/admin/api/systemone");
text = await res.text();
check("B1 GET /admin/api/systemone as admin → 200", res.status === 200, `${res.status} ${text}`);
res = await admin.put("/admin/api/systemone", { model: null }, PANEL);
text = await res.text();
check("B1 PUT /admin/api/systemone {model:null} WITH the panel headers → 200", res.status === 200, `${res.status} ${text}`);
res = await admin.put("/admin/api/systemone", { model: null });
text = await res.text();
check("B1 same PUT WITHOUT the panel headers → 403", res.status === 403, `${res.status} ${text}`);
// Which header matters (information only).
for (const drop of Object.keys(PANEL)) {
  const headers = { ...PANEL };
  delete headers[drop];
  console.log(`     PUT without ${drop}: ${await show(await admin.put("/admin/api/systemone", { model: null }, headers))}`);
}
console.log(`     PUT with Origin https://evil.example: ${await show(await admin.put("/admin/api/systemone", { model: null }, { ...PANEL, origin: "https://evil.example" }))}`);
res = await anon.put("/admin/api/systemone", { model: null }, PANEL);
check("B1 (extra) anonymous PUT with the panel headers → 403", res.status === 403, await show(res));
// The two other new routes exist behind the proxy (a 4xx from pi's own validation, not a 404).
res = await admin.post("/admin/api/systemone/probe", { model: { baseUrl: "http://10.217.0.10:18091/v1", apiKey: "" } }, PANEL);
text = await res.text();
check("B1 (extra) POST /admin/api/systemone/probe reaches pi and lists the fake server's models", res.status === 200 && text.includes("fake-model"), `${res.status} ${text.slice(0, 300)}`);
res = await admin.post("/admin/api/systemone/test", { model: { baseUrl: "http://10.217.0.10:18091/v1", apiKey: "", id: "fake-model" } }, PANEL);
text = await res.text();
check("B1 (extra) POST /admin/api/systemone/test is routed (not 404)", res.status !== 404, `${res.status} ${text.slice(0, 300)}`);
res = await admin.get("/admin/api/systemone");
console.log("     final GET /admin/api/systemone:", await show(res));
finish();
