#!/usr/bin/env node
// T9 — pi ad2d30f: the admin panel's "실행 시간" page reads GET /admin/api/traces/stats (the last 7 days'
// turns, up to 500, counted from Jaeger on every open). pi's commit checked the numbers against a local
// Jaeger and the page with MOCK data only. Here, through Noah's /admin proxy on the boot stack:
//   the route answers an admin (and nobody else), its numbers agree with Jaeger's own answer, it carries no
//   conversation content, Noah audits the read, and a stopped trace store is a clean 503.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { check, finish } from "./e2e-common.mjs";
import { W, admin, anon, jaegerRaw, member, names, sessionWith, state, tracedTurn, waitForTrace } from "./tracing-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (...args) => execFileSync("docker", ["exec", "-w", `${W}/noah-almighty`, "noahcompose-dind", "docker", "compose", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function stats(c = admin) {
  let started = Date.now();
  let res;
  try {
    res = await c.get("/admin/api/traces/stats");
  } catch {
    // An idle keep-alive socket Noah already closed (its 5 s keep-alive; `compose stop` takes longer): ask again.
    started = Date.now();
    res = await c.get("/admin/api/traces/stats");
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json, ms: Date.now() - started, type: res.headers.get("content-type") ?? "" };
}

// ---- two traced turns (bash in the sandbox + an MCP tool), and their traces are in
const runs = [await tracedTurn("T9 통계 턴 1"), await tracedTurn("T9 통계 턴 2")];
check("T9 two owner turns (bash + mcp_call) complete", runs.every((r) => r.ok && r.llmCalls === 3), runs.map((r) => `LLM calls ${r.llmCalls}`).join("; "));
const sessions = [];
for (const run of runs) {
  const session = await sessionWith(run.markers.user);
  sessions.push(session);
  if (!session) continue;
  await waitForTrace(session.id, (trace) => {
    const n = names(trace);
    return n.includes("gateway:invoke_agent") && n.includes("gateway:execute_tool bash") && n.includes("gateway:execute_tool mcp_call") && n.some((x) => x.startsWith("sandboxd:")) && n.some((x) => x.startsWith("mcp-broker:"));
  });
}
check("   both pi sessions are found and their traces are complete", sessions.every(Boolean), sessions.map((s) => s?.id).join(", "));

// ---- the route, as an admin
const got = await stats();
writeFileSync(`${W}/evidence/T9-trace-stats.json`, got.text);
const s = got.json ?? {};
console.log(`   GET /admin/api/traces/stats → ${got.status} in ${got.ms} ms, ${got.text.length} bytes, ${got.type}`);
console.log(`   turns ${s.turns} (limit ${s.limit}), since ${s.since}, failed ${s.failed}, turnMs ${JSON.stringify(s.turnMs)}, firstTokenMs ${JSON.stringify(s.firstTokenMs)}, share ${JSON.stringify(s.share)}`);
console.log(`   models: ${(s.models ?? []).map((m) => `${m.model} calls=${m.calls} errors=${m.errors} tok/s=${m.tokensPerSecond}`).join("; ")}`);
console.log(`   steps (${(s.steps ?? []).length}): ${(s.steps ?? []).map((x) => `[${x.service}] ${x.name} ×${x.calls}`).join(" | ")}`);
check("T9 the stats route → 200 JSON for an admin through Noah's proxy", got.status === 200 && /application\/json/.test(got.type) && typeof s.turns === "number");
check("   it counted at least the two turns just made, under the 500 limit", s.turns >= 2 && s.limit === 500 && s.turns <= s.limit, `turns ${s.turns}`);
check("   turn time and first-token percentiles are positive and ordered (p50 ≤ p95)", s.turnMs?.p50 > 0 && s.turnMs.p50 <= s.turnMs.p95 && s.firstTokenMs?.p50 > 0 && s.firstTokenMs.p50 <= s.firstTokenMs.p95);
const shareSum = (s.share?.llmMs ?? 0) + (s.share?.toolMs ?? 0) + (s.share?.otherMs ?? 0);
check("   the three shares (LLM / tools / other) are non-negative and add up to time actually spent", s.share && Object.values(s.share).every((v) => v >= 0) && shareSum > 0, `sum ${Math.round(shareSum)} ms`);
const model = (s.models ?? []).find((m) => m.model === "fake-model");
check("   the model table lists fake-model with its LLM calls", Boolean(model) && model.calls >= 6, model ? `calls ${model.calls}` : "no fake-model row");
const step = (service, name) => (s.steps ?? []).find((x) => x.service === service && x.name === name);
check("   steps: `execute_tool bash` of the gateway", Boolean(step("gateway", "execute_tool bash")) && step("gateway", "execute_tool bash").calls >= 2);
check("   steps: mcp_call is listed per REAL MCP tool (`execute_tool mcp_call todo/add_todos`)", (s.steps ?? []).some((x) => x.service === "gateway" && x.name === "execute_tool mcp_call todo/add_todos" && x.calls >= 2), (s.steps ?? []).filter((x) => x.name.includes("mcp_call")).map((x) => x.name).join(" | "));
check("   steps: sandboxd and mcp-broker time is there too", (s.steps ?? []).some((x) => x.service === "sandboxd") && (s.steps ?? []).some((x) => x.service === "mcp-broker"));
check("   the slowest list holds at most 10 turns, slowest first", Array.isArray(s.slowest) && s.slowest.length > 0 && s.slowest.length <= 10 && s.slowest.every((t, i, a) => i === 0 || a[i - 1].durationMs >= t.durationMs), `${s.slowest?.length} rows`);
// ---- pi e0681aa: the timeline (turns bucketed by start time) behind the page's "턴 시간 추이" chart
const tl = s.timeline ?? {};
const buckets = tl.buckets ?? [];
console.log(`   timeline: stepMs ${tl.stepMs}, ${buckets.length} bucket(s): ${buckets.map((b) => `${b.start.slice(11, 16)}×${b.turns}`).join(" ")}`);
check("T9 timeline: a step pi offers (5 min · 15 min · 1 h · 3 h · 6 h) and at least one bucket", [300000, 900000, 3600000, 10800000, 21600000].includes(tl.stepMs) && buckets.length >= 1, `stepMs ${tl.stepMs}`);
check("   the buckets' turns add up to the turn count", buckets.reduce((n, b) => n + b.turns, 0) === s.turns, `${buckets.reduce((n, b) => n + b.turns, 0)} vs ${s.turns}`);
check("   bucket starts are UTC boundaries of the step, ascending and contiguous", buckets.every((b, i) => Date.parse(b.start) % tl.stepMs === 0 && (i === 0 || Date.parse(b.start) - Date.parse(buckets[i - 1].start) === tl.stepMs)));
check("   the shortest step that fits ~28 buckets was chosen (first to last bucket within 29 steps)", buckets.length <= 29, `${buckets.length} buckets`);
check("   a bucket with turns has ordered percentiles; an empty one has none to show", buckets.every((b) => (b.turns > 0 ? b.turnMs?.p50 > 0 && b.turnMs.p50 <= b.turnMs.p95 : true)));
const overallMax = Math.max(...buckets.filter((b) => b.turns > 0).map((b) => b.turnMs.p95));
check("   no bucket's p95 exceeds the slowest turn of the whole answer", overallMax <= (s.slowest?.[0]?.durationMs ?? 0) + 1, `max bucket p95 ${Math.round(overallMax)} ms vs slowest ${Math.round(s.slowest?.[0]?.durationMs ?? 0)} ms`);

let resolvable = 0;
for (const t of s.slowest ?? []) if ((await admin.get(`/admin/api/history/${encodeURIComponent(t.sessionId)}`)).status === 200) resolvable++;
check("   every slowest row names a pi session the history page can open", resolvable === (s.slowest ?? []).length, `${resolvable}/${(s.slowest ?? []).length}`);

// ---- the numbers against Jaeger's own answer (from inside the gateway container)
const min = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const max = new Date(Date.now() + 60_000).toISOString();
const raw = jaegerRaw(`/api/v3/traces?query.service_name=gateway&query.operation_name=invoke_agent&query.start_time_min=${encodeURIComponent(min)}&query.start_time_max=${encodeURIComponent(max)}&query.search_depth=500`);
const roots = new Map();
// pi fed9753: a model's output speed = the sum of its output tokens ÷ the sum of its call time.
const chat = { tokens: 0, ms: 0, calls: 0 };
const micros = (nanos) => Number(BigInt(nanos) / 1000n) / 1000;
for (const line of raw.text.split("\n")) {
  if (!line.trim()) continue;
  for (const rs of JSON.parse(line).result?.resourceSpans ?? []) {
    for (const span of (rs.scopeSpans ?? []).flatMap((x) => x.spans ?? [])) {
      if (span.name === "invoke_agent" && !span.parentSpanId) roots.set(span.traceId, Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1000n) / 1000);
      if (span.name.startsWith("chat ")) {
        const attr = (key) => (span.attributes ?? []).find((x) => x.key === key)?.value;
        const output = Number(attr("gen_ai.usage.output_tokens")?.intValue ?? 0);
        if (attr("gen_ai.request.model")?.stringValue === "fake-model" && output > 0) {
          chat.tokens += output;
          chat.ms += micros(span.endTimeUnixNano) - micros(span.startTimeUnixNano);
          chat.calls += 1;
        }
      }
    }
  }
}
const durations = [...roots.values()].sort((a, b) => a - b);
const at = (p) => Math.round(durations[Math.max(Math.ceil(durations.length * p) - 1, 0)] ?? 0);
check("   the turn count equals the number of turn traces Jaeger itself returns", raw.status === 200 && roots.size === s.turns, `jaeger ${roots.size}, route ${s.turns}`);
check("   turn-time p50 / p95 equal the ones recomputed from Jaeger's raw spans", at(0.5) === s.turnMs?.p50 && at(0.95) === s.turnMs?.p95, `recomputed ${at(0.5)} / ${at(0.95)}, route ${s.turnMs?.p50} / ${s.turnMs?.p95}`);
check("   the slowest turn is the longest root span in Jaeger", Math.round(durations.at(-1) ?? -1) === s.slowest?.[0]?.durationMs, `jaeger ${Math.round(durations.at(-1) ?? -1)}, route ${s.slowest?.[0]?.durationMs}`);

const speed = chat.ms > 0 ? chat.tokens / (chat.ms / 1000) : 0;
console.log(`   output speed: ${chat.tokens} output tokens over ${Math.round(chat.ms)} ms in ${chat.calls} calls → ${Math.round(speed)} token/s recomputed; route says ${model?.tokensPerSecond}`);
check("   the model's output speed equals output tokens ÷ call time recomputed from Jaeger (pi fed9753), not tens of thousands", Boolean(model) && Math.abs(model.tokensPerSecond - Math.round(speed)) <= 1 && model.tokensPerSecond > 0 && model.tokensPerSecond < 10_000, `route ${model?.tokensPerSecond}, recomputed ${Math.round(speed)}`);

// ---- no conversation content
const count = (text, needle) => text.split(needle).length - 1;
for (const run of runs) {
  for (const [kind, marker] of Object.entries(run.markers)) check(`T9 marker of the ${kind} (${marker}) — 0 hits in the stats answer`, count(got.text, marker) === 0);
}
check("   (control) the same grep finds what IS there: a pi session id", sessions.some((x) => x && count(got.text, x.id) > 0));
check("   …and no Noah conversation id, user id, username, command text or Korean prompt text", [...runs.map((r) => r.conversationId), state.owner.id, state.owner.username, "echo ", "[[fake:", "통계 턴", "trace check"].every((x) => count(got.text, x) === 0));

// ---- who may read it
let res = await stats(member);
check("T9 a non-admin member → 403", res.status === 403, `${res.status} ${res.text.slice(0, 90)}`);
res = await stats(anon);
check("T9 anonymous → 403", res.status === 403, `${res.status} ${res.text.slice(0, 90)}`);

// ---- Noah audits the read (it is not one of the proxy's unaudited config reads: it names sessions)
const audit = (await (await admin.get("/api/audit")).json()).audit ?? [];
const rows = audit.filter((e) => e.action === "pi_admin_proxy" && e.detail.startsWith("GET /admin/api/traces/stats"));
check("T9 Noah's audit log has a `pi_admin_proxy` row for the read", rows.length >= 1 && rows.every((e) => e.status === "success"), `${rows.length} row(s): ${rows[0]?.detail ?? ""}`);

// ---- a stopped trace store
dc("stop", "jaeger");
res = await stats();
check("T9 with jaeger stopped → 503 trace_store_unavailable (no hang, no crash)", res.status === 503 && res.text.includes("trace_store_unavailable"), `${res.status} in ${res.ms} ms ${res.text.slice(0, 100)}`);
dc("start", "jaeger");
let back = null;
for (let i = 0; i < 30; i++) {
  back = await stats();
  if (back.status === 200) break;
  await sleep(2000);
}
check("   …and after jaeger starts again the route answers 200 with the same turns (they were on disk)", back?.status === 200 && back.json?.turns === s.turns, `${back?.status}, turns ${back?.json?.turns}`);

finish();
