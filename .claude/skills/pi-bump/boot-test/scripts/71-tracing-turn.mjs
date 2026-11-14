#!/usr/bin/env node
// T4 (a turn leaves a trace, admin-only), T5 (no content in traces), T6 (a subagent's spans hang under Agent).
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { check, fake, finish, turn } from "./e2e-common.mjs";
import { W, admin, ancestors, anon, jaegerRaw, member, names, ownerSessions, sessionWith, state, tracedTurn, traces, tree, waitForTrace } from "./tracing-lib.mjs";

// ---------------------------------------------------------------------------------------------- T4
const run = await tracedTurn("T4 추적 턴");
check("T4 the owner turn (bash in the sandbox + mcp_call mcp__todo__add_todos) completes", run.ok && run.llmCalls === 3, `LLM calls ${run.llmCalls}; ${JSON.stringify(run.t.json ?? run.t.of("error"))}`);
check("   (control) the markers really were in the tool results the model received", run.toolTexts[0]?.includes(run.markers.command) && run.toolTexts[0]?.includes(run.markers.result) && (run.toolTexts[1] ?? "").length > 0, `bash → ${JSON.stringify(run.toolTexts[0])}; mcp_call → ${JSON.stringify((run.toolTexts[1] ?? "").slice(0, 140))}`);

const list = await ownerSessions();
check("   GET /admin/api/history (proxy, admin) lists pi sessions", list.status === 200 && list.items.length > 0, `${list.items.length} sessions of the owner; item keys: ${Object.keys(list.items[0] ?? {}).join(", ")}`);
const session = await sessionWith(run.markers.user);
check("   the pi session of this conversation is found (its transcript holds the user marker)", Boolean(session), session ? `pi session ${session.id}, user ${session.user === state.owner.id ? "= the owner's Noah user id" : session.user}, model ${session.model}, turn ${session.turn}` : "not found");
// How Noah's conversation maps to it: what Noah itself exposes.
const messages = await (await admin.get(`/api/messages?conversationId=${run.conversationId}`)).json();
const noahJson = JSON.stringify({ messages, done: run.done });
const respIds = [...new Set(noahJson.match(/resp_[A-Za-z0-9-]+_\d+/g) ?? [])];
console.log(`   Noah conversation ${run.conversationId} → pi session ${session?.id}`);
console.log(`   pi response ids visible in Noah's own API output for the conversation (messages + done frame): ${respIds.join(", ") || "(none)"}`);
console.log(`   Noah conversation id inside the pi transcript: ${session?.transcript.includes(run.conversationId)}; is the pi session id the Noah conversation id: ${session?.id === run.conversationId}`);

const want = (trace) => {
  const n = names(trace);
  return n.includes("gateway:invoke_agent") && n.filter((x) => x.startsWith("gateway:chat ")).length >= 3 && n.includes("gateway:execute_tool bash") && n.includes("gateway:execute_tool mcp_call") && n.some((x) => x.startsWith("sandboxd:")) && n.some((x) => x.startsWith("mcp-broker:"));
};
const got = await waitForTrace(session.id, want);
const trace = got.traces[0];
writeFileSync(`${W}/evidence/T4-traces-admin-route.json`, got.text);
console.log(`   GET /admin/api/history/${session.id}/traces → ${got.status}, ${got.traces.length} trace(s); newest: traceId ${trace?.traceId}, turn ${trace?.turn}, ${Math.round(trace?.durationMs ?? 0)} ms, ${trace?.spans.length} spans`);
console.log(tree(trace).split("\n").map((l) => "     " + l).join("\n"));
const n = names(trace);
check("T4 the traces route → 200 with the turn's root span `invoke_agent`", got.status === 200 && n.includes("gateway:invoke_agent") && trace.spans.filter((s) => !s.parentId).length === 1);
check("   the LLM calls: three `chat fake-model` spans", n.filter((x) => x === "gateway:chat fake-model").length === 3, n.filter((x) => x.startsWith("gateway:chat")).join(", "));
check("   `execute_tool bash` and `execute_tool mcp_call`", n.includes("gateway:execute_tool bash") && n.includes("gateway:execute_tool mcp_call"));
const bash = trace.spans.find((s) => s.name === "execute_tool bash");
const mcp = trace.spans.find((s) => s.name === "execute_tool mcp_call");
const under = (parent, service) => trace.spans.filter((s) => s.service === service && ancestors(trace, s).some((a) => a.id === parent?.id));
check("   sandboxd children under the bash tool span", under(bash, "sandboxd").length > 0, under(bash, "sandboxd").map((s) => s.name).join(", "));
check("   mcp-broker children under the mcp_call tool span", under(mcp, "mcp-broker").length > 0, under(mcp, "mcp-broker").map((s) => s.name).join(", "));
let res = await traces(session.id, member);
check("T4 a non-admin member → 403", res.status === 403 && res.traces.length === 0, `${res.status} ${res.text.slice(0, 90)}`);
res = await traces(session.id, anon);
check("T4 anonymous → 403", res.status === 403, `${res.status} ${res.text.slice(0, 90)}`);
res = await member.get("/admin/api/history");
check("   (extra) the member cannot list sessions either", res.status === 403, `${res.status}`);
res = await traces(randomUUID());
check("   (extra) an unknown session id → 404 session_not_found", res.status === 404 && res.text.includes("session_not_found"), `${res.status}`);

// ---------------------------------------------------------------------------------------------- T5
const raw = jaegerRaw(`/api/v3/traces/${trace.traceId}`);
writeFileSync(`${W}/evidence/T5-trace-jaeger-raw.json`, raw.text);
const adminText = got.text;
const count = (text, needle) => text.split(needle).length - 1;
check("T5 Jaeger's own API (from inside the gateway container) returns the same trace", raw.status === 200 && raw.text.includes(trace.traceId) && count(raw.text, '"spanId"') === trace.spans.length, `HTTP ${raw.status}, ${raw.text.length} bytes, ${count(raw.text, '"spanId"')} spans`);
for (const [kind, marker] of Object.entries(run.markers)) {
  check(`T5 marker of the ${kind} (${marker}) — 0 hits in the admin route's answer and 0 in Jaeger's raw trace`, count(adminText, marker) === 0 && count(raw.text, marker) === 0, `admin route ${count(adminText, marker)}, jaeger raw ${count(raw.text, marker)}; in pi's transcript (control): ${count(session.transcript, marker)}`);
}
check("   (control) the same grep does find what IS in the trace: the pi session id", count(adminText, session.id) > 0 && count(raw.text, session.id) > 0, `admin route ${count(adminText, session.id)}, jaeger raw ${count(raw.text, session.id)}`);
check("   …and nothing else of the conversation: no Noah conversation id, user id, username, 'echo', '[[fake:' or Korean text", [run.conversationId, state.owner.id, state.owner.username, "echo ", "[[fake:", "추적", "trace check"].every((x) => count(raw.text, x) === 0), [run.conversationId, state.owner.id, state.owner.username, "echo ", "[[fake:", "추적", "trace check"].map((x) => `${JSON.stringify(x.slice(0, 12))}:${count(raw.text, x)}`).join(" "));
const keys = [...new Set(trace.spans.flatMap((s) => Object.keys(s.attributes)))].sort();
console.log("   span attribute KEYS:", keys.join(", "));
const rawKeys = [...new Set([...raw.text.matchAll(/"key":"([^"]+)"/g)].map((m) => m[1]))].sort();
console.log("   every attribute key in Jaeger's raw answer (span + resource + scope):", rawKeys.join(", "));
const values = {};
for (const s of trace.spans) for (const [k, v] of Object.entries(s.attributes)) (values[k] ??= new Set()).add(String(v).slice(0, 60));
console.log("   attribute values seen:", Object.entries(values).map(([k, v]) => `${k}=${[...v].slice(0, 4).join("|")}`).join("; "));
const allowed = /^(gen_ai\.(operation\.name|conversation\.id|request\.model|tool\.name|tool\.call\.id|usage\.[a-z_.]+|response\.finish_reasons)|pi_gateway\.[a-z_]+|error\.type)$/;
// `@jaeger@*` keys are Jaeger's own annotations on a span (its clock-skew warning), nothing pi wrote: listed, not judged.
const piKeys = keys.filter((k) => !k.startsWith("@jaeger@"));
const jaegerOwn = keys.filter((k) => k.startsWith("@jaeger@"));
if (jaegerOwn.length) console.log(`   Jaeger's own keys (skipped): ${jaegerOwn.join(", ")} = ${[...new Set(trace.spans.flatMap((s) => jaegerOwn.map((k) => s.attributes[k]).filter(Boolean).map((v) => String(v).slice(0, 120))))].join(" | ")}`);
check("   every span attribute key is a name / id / count / duration kind (gen_ai.*, pi_gateway.*, error.type)", piKeys.every((k) => allowed.test(k)), piKeys.filter((k) => !allowed.test(k)).join(", ") || "no other keys");

// ---------------------------------------------------------------------------------------------- T6
const stamp = Date.now().toString(36);
const KEY = `tagent-${stamp}`;
const SUB = `tsub-${stamp}`;
const subMarker = `TRACESUBAGENT${stamp}`;
await fake.enqueue(KEY, [
  { toolCalls: [{ name: "Agent", arguments: { description: "Count upload files", prompt: `[[fake:${SUB}]] ${subMarker} list /workspace/uploads`, subagent_type: "general-purpose" } }] },
  { text: "하위 에이전트 보고 완료." },
]);
await fake.enqueue(SUB, [{ toolCalls: [{ name: "bash", arguments: { command: "ls /workspace/uploads | wc -l" } }] }, { text: "subagent report" }]);
const sub = await turn(admin, { avatarId: state.owner.id, conversationId: randomUUID(), message: `T6 하위 에이전트 ${subMarker}-PARENT [[fake:${KEY}]]` });
check("T6 the subagent turn completes with agent / agent_end frames", sub.status === 200 && sub.of("done").length === 1 && sub.of("agent").length === 1 && sub.of("agent_end")[0]?.ok === true);
const subSession = await sessionWith(`${subMarker}-PARENT`);
const subGot = await waitForTrace(subSession.id, (t) => names(t).includes("gateway:execute_tool Agent") && names(t).includes("gateway:execute_tool bash") && names(t).some((x) => x.startsWith("sandboxd:")));
const subTrace = subGot.traces[0];
writeFileSync(`${W}/evidence/T6-subagent-trace.json`, subGot.text);
console.log(tree(subTrace).split("\n").map((l) => "     " + l).join("\n"));
const agentSpan = subTrace.spans.find((s) => s.name === "execute_tool Agent");
const below = subTrace.spans.filter((s) => ancestors(subTrace, s).some((a) => a.id === agentSpan?.id));
const direct = subTrace.spans.filter((s) => s.parentId === agentSpan?.id).map((s) => s.name);
check("T6 the subagent's LLM calls (2 × chat) and its tool span (execute_tool bash, with sandboxd below it) hang under `execute_tool Agent`", Boolean(agentSpan) && below.filter((s) => s.name === "chat fake-model").length === 2 && below.some((s) => s.name === "execute_tool bash") && below.some((s) => s.service === "sandboxd"), `direct children of Agent: ${direct.join(", ")}`);
const parentChats = subTrace.spans.filter((s) => s.name === "chat fake-model" && !ancestors(subTrace, s).some((a) => a.id === agentSpan?.id));
check("   the parent's own 2 LLM calls stay directly under invoke_agent", parentChats.length === 2 && parentChats.every((s) => ancestors(subTrace, s)[0]?.name === "invoke_agent"));
check("   the subagent prompt's marker is not in the trace", !subGot.text.includes(subMarker));
writeFileSync(`${W}/evidence/T-sessions.json`, JSON.stringify({ t4: { conversationId: run.conversationId, sessionId: session.id, traceId: trace.traceId, markers: run.markers }, t6: { sessionId: subSession.id, traceId: subTrace.traceId } }, null, 1));
finish();
