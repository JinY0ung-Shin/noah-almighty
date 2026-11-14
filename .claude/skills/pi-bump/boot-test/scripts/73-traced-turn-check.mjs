#!/usr/bin/env node
// NOT in the default run (drive.sh): called by 72-tracing-ops.sh.
// One traced owner turn (bash + mcp_call) and a check of its trace.
//   node 73-traced-turn-check.mjs traced <label>     the turn must complete AND leave a full trace
//   node 73-traced-turn-check.mjs untraced <label>   (Jaeger stopped) the turn must complete; reports what the traces route answers
//   node 73-traced-turn-check.mjs old <sessionId>    an EARLIER session's trace is still readable (persistence)
import { check, finish } from "./e2e-common.mjs";
import { names, sessionWith, tracedTurn, traces, waitForTrace } from "./tracing-lib.mjs";
const [mode, label] = process.argv.slice(2);
if (mode === "old") {
  const got = await traces(label);
  check(`the earlier session ${label} still has its trace`, got.status === 200 && got.traces.length >= 1 && names(got.traces[0]).includes("gateway:invoke_agent"), `${got.status}, ${got.traces.length} trace(s), ${got.traces[0]?.spans.length} spans`);
  finish();
}
const started = Date.now();
const run = await tracedTurn(label);
check(`[${label}] the turn completes (bash + mcp_call, 3 LLM calls)`, run.ok && run.llmCalls === 3 && run.toolTexts[0]?.includes(run.markers.result), `${Date.now() - started} ms; ${JSON.stringify(run.t.json ?? run.t.of("error"))}`);
const session = await sessionWith(run.markers.user);
console.log(`SESSION ${session?.id}`);
if (mode === "traced") {
  const got = await waitForTrace(session.id, (t) => names(t).includes("gateway:invoke_agent") && names(t).includes("gateway:execute_tool bash") && names(t).some((x) => x.startsWith("sandboxd:")) && names(t).some((x) => x.startsWith("mcp-broker:")));
  const n = names(got.traces[0]);
  check(`[${label}] the turn left a trace with gateway, sandboxd and mcp-broker spans`, got.status === 200 && n.includes("gateway:invoke_agent") && n.some((x) => x.startsWith("sandboxd:")) && n.some((x) => x.startsWith("mcp-broker:")), `${got.status}; ${n.join(", ")}`);
} else {
  const got = await traces(session.id);
  console.log(`[${label}] traces route while Jaeger is down: HTTP ${got.status} ${got.text.slice(0, 160)}`);
  check(`[${label}] the traces route answers an error status, not a hang or a 200 with wrong data`, got.status === 503 || got.status === 502, `${got.status}`);
}
finish();
