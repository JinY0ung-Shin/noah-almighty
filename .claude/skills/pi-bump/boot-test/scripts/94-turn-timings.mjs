#!/usr/bin/env node
// Q — `mcp__system__turn_timings` THROUGH the stack (pi-gateway 680f300, 2026-11-14): pi's new
// `GET /v1/responses/{id}/traces` (service key + `?user=`) read by Noah's tool, against the REAL Jaeger — pi's own
// commit only stubbed it. One owner conversation, every call scripted by the fake LLM; what the tool answered is
// read back from the model's next request.
//   turn 1  bash `sleep 2` + turn_timings  → nothing finished yet (pi is not asked: no earlier response)
//   turn 2  turn_timings                   → turn 1, measured: the bash step ≥ 2 s, by name
//   a colleague's chat with the owner's avatar → refused before any read
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";
import { sessionWith, waitForTrace, names } from "./tracing-lib.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const second = client(state.second.cookie);
const RUN = Date.now().toString(36);
const MARK = `TIMINGUSER${RUN}`;
const ALL = [];

async function scripted(c, { conv, key, calls, label }) {
  await fake.enqueue(key, [...calls.map((call) => ({ toolCalls: [call] })), { text: `끝 (${label})` }]);
  const t = await turn(c, { avatarId: state.owner.id, conversationId: conv, message: `시간 ${label} ${MARK} [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const tools = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)).slice(-calls.length);
  const done = t.of("done")[0];
  const ok = t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && String(done?.message?.content ?? "").includes(`끝 (${label})`);
  if (!ok) console.log(`  [${label}] status ${t.status} ${JSON.stringify(t.json ?? t.of("error")).slice(0, 400)}`);
  return { ok, tools };
}
const timings = (args = {}) => ({ name: "mcp_call", arguments: { name: "mcp__system__turn_timings", arguments: args } });
const show = (label, text) => {
  ALL.push(`=== ${label}\n${text ?? "(no tool result)"}`);
  console.log(`  ${label}:\n${String(text ?? "(no tool result)").split("\n").map((l) => "    " + l).join("\n")}`);
};

// ---------------------------------------------------------------------------------------------- turn 1
const conv = randomUUID();
const key = `timing-${RUN}`;
const t1 = await scripted(owner, { conv, key, calls: [{ name: "bash", arguments: { command: "sleep 2; echo slept" } }, timings()], label: "first" });
show("turn 1: turn_timings on the conversation's first turn", t1.tools[1]);
check("Q  turn 1 (bash `sleep 2`, then turn_timings) completes", t1.ok && (t1.tools[0] ?? "").includes("slept"));
check("Q  on the first turn the tool reports nothing finished yet — not an error, not a number", (t1.tools[1] ?? "").includes("No finished turn to report yet") && !/\d+(\.\d+)? (ms|s)\b/.test(t1.tools[1] ?? ""));

// Turn 1's trace reaches Jaeger a batch interval after the turn ends (seen through the admin route, as 71- does).
const session = await sessionWith(MARK);
check("   the pi session of this conversation is found", Boolean(session), session ? `pi session ${session.id}` : "not found");
const exported = session ? await waitForTrace(session.id, (trace) => names(trace).includes("gateway:execute_tool bash") && names(trace).some((n) => n.startsWith("sandboxd:"))) : { traces: [] };
const adminTrace = exported.traces.find((t) => t.turn === 1) ?? exported.traces.at(-1);
const adminBash = adminTrace?.spans.find((s) => s.name === "execute_tool bash");
check("   (control) the admin route shows turn 1 with its bash span", Boolean(adminBash), adminBash ? `turn ${adminTrace.turn}: ${Math.round(adminTrace.durationMs)} ms, execute_tool bash ${Math.round(adminBash.durationMs)} ms` : `${exported.traces.length} trace(s)`);

// ---------------------------------------------------------------------------------------------- turn 2
const t2 = await scripted(owner, { conv, key, calls: [timings()], label: "second" });
const report = t2.tools[0] ?? "";
show("turn 2: turn_timings", report);
check("Q  turn 2 (turn_timings alone) completes", t2.ok);
check("Q  the report is turn 1 of this session and only that (the turn in progress is not in it)", /\(1 of 1 recorded turn shown\)/.test(report) && /^Turn 1 — started \d{4}-\d\d-\d\dT/m.test(report) && !/^Turn 2 —/m.test(report));
const bashLine = report.split("\n").find((l) => l.includes("execute_tool bash — "));
const bashSeconds = Number(/execute_tool bash — (\d+(?:\.\d+)?) s/.exec(bashLine ?? "")?.[1] ?? NaN);
check("Q  the slowest step is the bash call, by name, measured at ≥ 2 s (the `sleep 2`)", /^\s+1\. execute_tool bash — /.test(bashLine ?? "") && bashSeconds >= 2 && bashSeconds < 30, bashLine?.trim());
check(
  "Q  …and it is the SAME measurement the admin panel shows (±0.1 s of the admin route's span)",
  Boolean(adminBash) && Math.abs(bashSeconds * 1000 - adminBash.durationMs) <= 100,
  adminBash ? `tool ${bashSeconds} s, admin route ${Math.round(adminBash.durationMs)} ms` : "",
);
check("Q  what the sandbox did is named inside the bash step", /inside it: .*sandboxd /.test(report), report.split("\n").find((l) => l.includes("inside it:"))?.trim());
check("Q  the model / tools / other split and the first-token line are there", /^\s+model: .* in 3 calls; tools: .* in 2 calls; other: /m.test(report) && /first token of the answer: /.test(report), report.split("\n").find((l) => l.trim().startsWith("model:"))?.trim());
check("Q  turn 1's own MCP call is listed by the tool it really called (pi's `server/tool` label)", report.includes("execute_tool mcp_call → system/turn_timings"));
check("Q  no content: neither the command nor the user's marker is in the report", !report.includes("sleep 2") && !report.includes("slept") && !report.includes(MARK));

// ---------------------------------------------------------------------------------------------- a colleague
const mateKey = `timing-mate-${RUN}`;
const mate = await scripted(second, { conv: randomUUID(), key: mateKey, calls: [timings()], label: "colleague" });
show("a colleague's chat with the owner's avatar: turn_timings", mate.tools[0]);
check("Q  a colleague's chat with the owner's avatar: the turn completes and the tool refuses (owner only)", mate.ok && (mate.tools[0] ?? "").includes("can only be used in a conversation the avatar owner is participating in") && !/Turn \d+ —/.test(mate.tools[0] ?? ""));

writeFileSync(`${W}/evidence/Q-turn-timings-tool-results.txt`, ALL.join("\n\n") + "\n");
finish();
