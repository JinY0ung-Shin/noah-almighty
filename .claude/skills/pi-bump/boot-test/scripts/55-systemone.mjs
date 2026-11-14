#!/usr/bin/env node
// New in pi 7e8e3d6: System One "recent calls" (GET /admin/api/systemone/calls), the test button's request/answer,
// and the "compare with BM25" switch — all through Noah's /admin proxy, with the fake LLM container answering
// POST /v1/systemone as the decision server and a scripted owner turn calling mcp_search.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { FAKE, NOAH, W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const anon = client();
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const QUERY = "할 일 목록에 항목 추가 todo";
const MODEL = { baseUrl: `${FAKE}/v1`, apiKey: "", headers: {}, id: "fake-decision", compare: false };

// Only mcp_search's own decision requests (the admin "test" button also posts to …/systemone, with another state).
const decisions = async () => (await (await fetch(`${FAKE}/_fake/decisions`)).json()).decisions.filter((d) => d.body?.state?.query === QUERY);
const setDecision = (body) => fetch(`${FAKE}/_fake/decision`, { method: "POST", body: JSON.stringify(body) });
const calls = async (c = admin) => {
  const res = await c.get("/admin/api/systemone/calls");
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
};
let n = 0;
/** One owner turn in a NEW conversation whose model calls mcp_search `times` times (then optional extra tool calls). */
async function searchTurn(label, { times = 1, then = [] } = {}) {
  const key = `s1-${Date.now().toString(36)}-${n++}`;
  await fake.enqueue(key, [
    { text: "도구를 찾아보겠습니다.", toolCalls: Array.from({ length: times }, () => ({ name: "mcp_search", arguments: { query: QUERY, limit: 3 } })) },
    ...then.map((toolCalls) => ({ toolCalls })),
    { text: `${label} 완료.` },
  ]);
  const t = await turn(admin, { avatarId: state.owner.id, conversationId: randomUUID(), message: `${label}: 할 일 도구를 찾아 줘 [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const toolTexts = (i) => (reqs[i]?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const first = toolTexts(1)[0] ?? "";
  return { ok: t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0, t, reqs, first, headings: first.match(/^## .+$/gm)?.map((h) => h.slice(3)) ?? [], toolTexts };
}
const NOAH_SERVERS = ["knowledge", "repo", "system", "todo", "confluence", "avatars", "skill_exchange", "ssh_identity", "git_repo", "brain", "canvas", "browser", "file_output", "ssh_trust", "skills", "hex-ssh", "plugins", "shared"];
const isNoahTool = (name) => NOAH_SERVERS.some((server) => name.startsWith(`mcp__${server}__`));

// ---- 0. the new route, before anything was asked -------------------------------------------------------
let c = await calls();
check("GET /admin/api/systemone/calls as a Noah admin → 200 with an items array", c.status === 200 && Array.isArray(c.json?.items), `${c.status} ${c.text.slice(0, 120)}`);
const startLength = c.json?.items?.length ?? 0;
const d0 = (await decisions()).length;
c = await calls(member);
check("…a non-admin member → 403", c.status === 403, `${c.status} ${c.text.slice(0, 120)}`);
c = await calls(anon);
check("…anonymous → 403 noah_session_required", c.status === 403 && c.text.includes("noah_session_required"), `${c.status}`);

// ---- 1. baseline: no System One → BM25 -----------------------------------------------------------------
const base = await searchTurn("기준(BM25)");
check("baseline (System One not configured): mcp_search returns Noah tools by BM25, the decision server is not asked", base.ok && base.headings.length === 3 && base.headings.every(isNoahTool) && (await decisions()).length === d0, base.headings.join(", "));
writeFileSync(`${W}/evidence/S1-mcp-search-result-bm25.txt`, base.first);

// ---- 2. configure System One against the fake decision server ------------------------------------------
let res = await admin.put("/admin/api/systemone", { model: MODEL }, PANEL);
let text = await res.text();
check("PUT /admin/api/systemone (fake decision server) → 200", res.status === 200 && JSON.parse(text).model?.id === "fake-decision" && JSON.parse(text).model?.compare === false, `${res.status} ${text}`);

// The decision server is DOWN (500): the search falls back to BM25 and the failure is listed.
await setDecision({ mode: "error" });
const down = await searchTurn("결정 서버 실패");
let asked = await decisions();
c = await calls();
check("decision server answering 500: mcp_search still returns the BM25 result", down.ok && down.headings.join("|") === base.headings.join("|") && asked.length === d0 + 1, down.headings.join(", "));
check("…and /systemone/calls lists that request with its error", c.json?.items?.length === startLength + 1 && c.json.items[0].request?.state?.query === QUERY && typeof c.json.items[0].error === "string" && !c.json.items[0].answer, JSON.stringify({ at: c.json?.items?.[0]?.at, durationMs: c.json?.items?.[0]?.durationMs, error: c.json?.items?.[0]?.error }));
const criteria = Object.keys(asked.at(-1)?.body?.questions?.choice?.criteria ?? {});
console.log(`  the decision request offers ${criteria.length} tools; Noah servers present: ${[...new Set(criteria.filter(isNoahTool).map((k) => k.split("__")[1]))].join(", ")}`);
console.log(`  not Noah's: ${criteria.filter((k) => !isNoahTool(k)).join(", ") || "(none)"}`);

// ---- 3. the decision server prefers two tools BM25 did not rank -----------------------------------------
const prefer = ["mcp__system__describe_system", ...criteria.filter((k) => isNoahTool(k) && !base.headings.includes(k) && k !== "mcp__system__describe_system").slice(-1)];
check("(setup) the preferred tools are offered and are not in the BM25 top 3", prefer.every((k) => criteria.includes(k) && !base.headings.includes(k)), prefer.join(", "));
await setDecision({ mode: "prefer", prefer });
const picked = await searchTurn("System One", { then: [[{ name: "mcp_call", arguments: { name: "mcp__system__describe_system", arguments: {} } }]] });
asked = await decisions();
c = await calls();
writeFileSync(`${W}/evidence/S1-mcp-search-result-model.txt`, picked.first);
writeFileSync(`${W}/evidence/S1-decision-requests.json`, JSON.stringify(asked, null, 1));
writeFileSync(`${W}/evidence/S1-systemone-calls.json`, JSON.stringify(c.json, null, 1));
check("(1) with System One the search still returns Noah tools, in the decision model's order", picked.ok && picked.headings.length === 3 && picked.headings.every(isNoahTool) && picked.headings[0] === prefer[0] && picked.headings[1] === prefer[1], picked.headings.join(", "));
const latest = c.json?.items?.[0];
check("(2) /systemone/calls lists that request (newest first): body sent, answer received, duration", c.json?.items?.length === startLength + 2 && latest?.request?.state?.query === QUERY && latest?.request?.model === "fake-decision" && latest?.answer?.choice === prefer[0] && typeof latest?.durationMs === "number" && !latest?.error, JSON.stringify({ at: latest?.at, durationMs: latest?.durationMs, model: latest?.request?.model, state: latest?.request?.state, choice: latest?.answer?.choice, p: latest?.answer?.probabilities?.[prefer[0]], criteria: Object.keys(latest?.request?.questions?.choice?.criteria ?? {}).length }));
check("    the fake decision server received exactly that request", asked.length === d0 + 2 && asked.at(-1).body.model === "fake-decision" && asked.at(-1).body.state?.query === QUERY && asked.at(-1).body.questions?.choice?.type === "choice", `POST …/systemone #${asked.length}`);
const described = picked.toolTexts(2).at(-1) ?? "";
check("    (extra) the tool the search surfaced is callable: mcp_call mcp__system__describe_system through the real broker", described.length > 200 && !/missing or invalid run token|Forbidden/.test(described), JSON.stringify(described.slice(0, 160)));
c = await calls(member);
check("(3) a non-admin member gets 403 for /systemone/calls (now non-empty)", c.status === 403 && !c.text.includes(QUERY), `${c.status} ${c.text.slice(0, 120)}`);
res = await member.get("/admin/api/systemone");
check("    …and for /admin/api/systemone", res.status === 403, `${res.status}`);

// The test button (065b62d): shows the request it sent and the answer; it is NOT added to the recent calls.
res = await admin.post("/admin/api/systemone/test", { model: MODEL }, PANEL);
text = await res.text();
const tested = JSON.parse(text);
check("POST /systemone/test returns the request sent and the answer received", res.status === 200 && tested.request?.questions && tested.answer?.type === "choice" && typeof tested.durationMs === "number", text.slice(0, 260));
c = await calls();
check("…and is not added to the recent calls", c.json?.items?.length === startLength + 2, `${c.json?.items?.length} items`);

// ---- 4. "compare with BM25": about half of the searches skip the decision model -------------------------
res = await admin.put("/admin/api/systemone", { model: { ...MODEL, compare: true } }, PANEL);
text = await res.text();
check("PUT compare:true → 200, stored", res.status === 200 && JSON.parse(text).model?.compare === true, text);
const beforeCompare = (await decisions()).length;
const compared = await searchTurn("비교", { times: 12 });
const askedInCompare = (await decisions()).length - beforeCompare;
const results = compared.toolTexts(1).map((result) => result.match(/^## .+$/gm)?.[0]?.slice(3));
const byModel = results.filter((h) => h === prefer[0]).length;
const byBm25 = results.filter((h) => h === base.headings[0]).length;
check("12 searches with compare on: some asked System One, some went to BM25 (random halves; all-or-nothing has p≈0.0005)", compared.ok && results.length === 12 && askedInCompare > 0 && askedInCompare < 12 && byModel === askedInCompare && byBm25 === 12 - askedInCompare, `decision requests ${askedInCompare}/12; top result = model's pick ${byModel}×, BM25's pick ${byBm25}×`);
c = await calls();
check("the recent-calls list keeps at most 20", c.json?.items?.length === Math.min(20, startLength + 2 + askedInCompare), `${c.json?.items?.length} items`);
res = await admin.get("/admin/api/status");
const status = await res.json();
console.log("  status page MCP-search statistic:", JSON.stringify(status.searches ?? null));

// ---- 5. System One removed again → BM25, the list stops growing -----------------------------------------
const lengthBefore = c.json?.items?.length;
const decisionsBefore = (await decisions()).length;
res = await admin.put("/admin/api/systemone", { model: null }, PANEL);
text = await res.text();
check("PUT {model:null} → 200, removed", res.status === 200 && JSON.parse(text).model === null, text);
const after = await searchTurn("제거 후");
c = await calls();
check("(4) with System One removed mcp_search is BM25 again (same result as the baseline) and nothing is asked", after.ok && after.headings.join("|") === base.headings.join("|") && (await decisions()).length === decisionsBefore, after.headings.join(", "));
check("    …and /systemone/calls stops growing", c.status === 200 && c.json?.items?.length === lengthBefore, `${c.json?.items?.length} items before and after`);
finish();
